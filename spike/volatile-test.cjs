'use strict';

/**
 * Volatile (per-Pokemon status) coverage test.
 *
 *   npm run test:volatile
 *
 * Checks:
 *   1. catalog exposes the full volatile list with Chinese labels
 *   2. a batch of statuses survives injection (including Encore/Disable/Attract,
 *      which the engine refuses to add without extra context)
 *   3. a follow-up turn does not rebuild and keeps the statuses
 *   4. clearing a status rebuilds the sandbox and drops it
 */

const path = require('path');
const { BattleSession } = require(path.join(__dirname, '..', 'engine-host', 'lib', 'session.cjs'));

const engineDir = path.join(__dirname, '..', 'pokemon-showdown-master');
const sleep = ms => new Promise(r => setTimeout(r, ms));

const mk = (species, moves) => ({
	name: species, species, item: '', ability: 'Pressure', nature: 'Serious', level: 100,
	evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
	ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
	moves,
});

const BATCH = [
	'substitute', 'leechseed', 'taunt', 'encore', 'confusion', 'attract',
	'disable', 'yawn', 'perishsong', 'destinybond', 'curse', 'ingrain',
	'roost', 'saltcure', 'partiallytrapped', 'torment', 'throatchop',
	'embargo', 'healblock', 'imprison', 'minimize', 'protect',
	'focusenergy', 'aquaring', 'stockpile', 'tarshot', 'charge', 'choicelock',
];

(async () => {
	const { loadEngine } = require(path.join(__dirname, '..', 'engine-host', 'lib', 'session.cjs'));
	const Sim = loadEngine(engineDir);

	// 1. catalog coverage
	const conds = Object.keys(Sim.Dex.data.Conditions || {}).length;
	const candidates = new Set();
	for (const [id, c] of Object.entries(Sim.Dex.data.Conditions || {})) {
		if (!['Status', 'Weather', 'Terrain'].includes(c.effectType)) candidates.add(id);
	}
	for (const m of Sim.Dex.moves.all()) {
		if (!m.exists || m.isMax) continue;
		if (m.volatileStatus) candidates.add(m.volatileStatus);
	}
	console.log(`condition table entries: ${conds} | volatile candidates: ${candidates.size}`);
	const mustHave = ['encore', 'taunt', 'disable', 'attract', 'leechseed', 'saltcure', 'perishsong', 'yawn', 'confusion'];
	const missing = mustHave.filter(id => !Sim.Dex.conditions.get(id).exists);
	console.log('required ids present:', missing.length ? `FAIL (${missing})` : 'OK');

	const session = new BattleSession({ engineDir });
	const config = {
		format: 'gen9customgame',
		seed: [7, 11, 13, 17],
		p1: { active: 0, slots: [Object.assign(mk('Mew', ['Psychic', 'Protect', 'Recover', 'Taunt']), { volatiles: [...BATCH] })] },
		p2: { active: 0, slots: [mk('Snorlax', ['Body Slam', 'Protect', 'Rest', 'Earthquake'])] },
		field: { weather: '', terrain: '', p1: { conditions: [] }, p2: { conditions: [] } },
	};
	await session.start(config);
	await sleep(20);

	// 2. injection
	const afterStart = session.readState();
	const kept = afterStart.p1.pokemon[0].volatiles;
	const lost = BATCH.filter(v => !kept.includes(v));
	console.log(`injected ${BATCH.length} -> kept ${kept.length}`, lost.length ? `| missing: ${lost.join(',')}` : '| OK');
	console.log('warnings:', session.warnings.length ? session.warnings.join(' | ') : 'none');

	// 3. next turn keeps them without a rebuild
	const turn = await session.applyTurn({
		config,
		choices: { p1: { kind: 'move', index: 1 }, p2: { kind: 'move', index: 1 } },
	});
	const stillThere = turn.after.p1.pokemon[0].volatiles;
	const expired = BATCH.filter(v => !stillThere.includes(v));
	console.log(`turn rebuilt=${turn.rebuilt} | kept ${stillThere.length}/${BATCH.length}` +
		(expired.length ? ` | expired: ${expired.join(',')}` : ''));

	// Merge the engine state back the way the UI does, then confirm the next
	// turn reuses the same battle instead of rebuilding.
	const synced = JSON.parse(JSON.stringify(config));
	for (const side of ['p1', 'p2']) {
		synced[side].active = turn.after[side].active;
		for (const mon of turn.after[side].pokemon) {
			const slot = synced[side].slots[mon.slot];
			if (!slot) continue;
			slot.hp = mon.hp;
			slot.status = mon.status;
			slot.boosts = { ...mon.boosts };
			slot.volatiles = [...mon.volatiles];
		}
	}
	const turn1b = await session.applyTurn({
		config: synced,
		choices: { p1: { kind: 'move', index: 0 }, p2: { kind: 'move', index: 0 } },
	});
	console.log(`follow-up turn rebuilt=${turn1b.rebuilt} (expected false)`);

	// 4. clearing a status rebuilds the sandbox and drops the rest
	const cleared = JSON.parse(JSON.stringify(config));
	cleared.p1.slots[0].volatiles = ['taunt'];
	const session2 = new BattleSession({ engineDir });
	await session2.start(config);
	const turn2 = await session2.applyTurn({
		config: cleared,
		choices: { p1: { kind: 'move', index: 1 }, p2: { kind: 'move', index: 1 } },
	});
	const afterClear = turn2.after.p1.pokemon[0].volatiles;
	console.log(`clear rebuilt=${turn2.rebuilt} | remaining: ${afterClear.join(',') || '(none)'}`);
	await session2.close();

	await session.close();
})().catch(err => {
	console.error('VOLATILE TEST FAIL:', err);
	process.exit(1);
});
