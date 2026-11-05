'use strict';

/**
 * Regression test: Encore + Torment must lead to Struggle, not a timeout.
 *
 *   npm run test:struggle
 *
 * The sandbox UI keeps the previously picked move index. Once Encore (and
 * then Torment) makes that index illegal, the host has to fall back to a
 * legal move / Struggle using the engine's request instead of sending the
 * stale index and waiting forever for a request that never arrives.
 *
 * PBSIM_ENGINE can point at a compiled Pokemon Showdown tree when running
 * from the clean build-kit (which ships no engine).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { BattleSession } = require(path.join(__dirname, '..', 'engine-host', 'lib', 'session.cjs'));
const { formatEvents } = require(path.join(__dirname, '..', 'engine-host', 'lib', 'format.cjs'));

const candidates = [
	process.env.PBSIM_ENGINE,
	path.join(__dirname, '..', 'pokemon-showdown-master'),
	'C:/Users/user/Desktop/PokemonSandbox/pokemon-showdown-master',
].filter(Boolean);
const engineDir = candidates.find(d => fs.existsSync(path.join(d, 'dist', 'sim', 'index.js')));
if (!engineDir) throw new Error('no compiled engine found; set PBSIM_ENGINE');

const SEED = [20685, 50038, 20263, 7353];
const ZH = { species: { Sableye: '勾魂眼', Kirlia: '奇鲁莉安' }, moves: { Struggle: '挣扎' } };

function config(withEncore) {
	const mon = (species, ability, moves, hp, volatiles = []) => ({
		species, item: '', ability, nature: 'Serious', level: 100, gender: '',
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
		moves, teraType: '', hp, status: '',
		boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0 },
		volatiles,
	});
	return {
		format: 'gen9customgame',
		seed: SEED,
		p1: { active: 0, slots: [mon('Sableye', 'Prankster', ['Pound', 'Encore', 'Torment', ''], 241)] },
		p2: { active: 0, slots: [mon('Kirlia', 'Synchronize', ['Psychic', 'Energy Ball', '', ''], 160, withEncore ? ['encore'] : [])] },
		field: { weather: '', terrain: '', p1: { conditions: [] }, p2: { conditions: [] } },
	};
}

function mergeAfter(cfg, after) {
	const next = JSON.parse(JSON.stringify(cfg));
	for (const side of ['p1', 'p2']) {
		next[side].active = after[side].active;
		for (const mon of after[side].pokemon) {
			const slot = next[side].slots?.[mon.slot];
			if (!slot) continue;
			slot.hp = mon.hp;
			slot.status = mon.status;
			slot.boosts = { ...mon.boosts };
			slot.pp = Object.fromEntries(mon.moves.map(m => [m.id, m.pp]));
			slot.volatiles = [...mon.volatiles];
		}
	}
	return next;
}

const has = (events, fragment) => events.some(line => line.includes(fragment));

async function play(mode) {
	const session = new BattleSession({ engineDir, format: 'gen9customgame', seed: SEED });
	let cfg = config(mode === 'import');
	await session.start(cfg);

	// Live: replay the two turns recorded in the save, then the Torment turn.
	// Import: the save already carries Encore, so start at the Torment turn.
	const turns = mode === 'live' ? [
		{ p1: { kind: 'move', index: 0 }, p2: { kind: 'move', index: 0 } },
		{ p1: { kind: 'move', index: 1 }, p2: { kind: 'move', index: 1 } },
	] : [];
	// Third turn: UI still holds p2's stale (Encore-disabled) Energy Ball pick.
	turns.push({ p1: { kind: 'move', index: 2 }, p2: { kind: 'move', index: 1 } });
	// Fourth turn: p2's request now holds only Struggle; the UI index is stale.
	turns.push({ p1: { kind: 'move', index: 0 }, p2: { kind: 'move', index: 1 } });

	const results = [];
	for (const choices of turns) {
		const res = await session.applyTurn({ config: cfg, choices });
		results.push(res);
		cfg = mergeAfter(cfg, res.after);
	}
	await session.close();
	return { results, cfg };
}

(async () => {
	console.log('engine:', engineDir);
	for (const mode of ['live', 'import']) {
		const { results } = await play(mode);
		const torment = results[results.length - 2];
		const struggle = results[results.length - 1];

		assert(has(torment.events, '|Torment|'), `${mode}: Torment was not used`);
		assert(has(torment.events, '|-start|p2a: Kirlia|Torment'), `${mode}: Torment status missing`);
		const volts = torment.after.p2.pokemon[0].volatiles;
		assert(volts.includes('encore') && volts.includes('torment'),
			`${mode}: expected Encore+Torment, got ${volts.join(',')}`);
		const reqMoves = torment.requests.p2.active[0].moves;
		assert(reqMoves.length === 1 && reqMoves[0].id === 'struggle',
			`${mode}: expected a Struggle-only request, got ${JSON.stringify(reqMoves)}`);

		assert(has(struggle.events, '|Struggle|'), `${mode}: Kirlia did not Struggle`);
		assert(has(struggle.events, '[from] recoil'), `${mode}: Struggle recoil missing`);
		assert(struggle.warnings.some(w => w.includes('挣扎')), `${mode}: missing Struggle notice`);
		const text = formatEvents(struggle.events, ZH, struggle.before);
		assert(text.some(line => line.includes('挣扎')), `${mode}: battle log has no Struggle line`);
		console.log(`[${mode}] Torment turn OK | auto-fallback: ${torment.warnings.join(' / ') || '(none)'}`);
		console.log(`[${mode}] Struggle turn OK | ${struggle.warnings.join(' / ')}`);

		if (mode === 'live') {
			assert(torment.warnings.some(w => w.includes('当前不可用')),
				'live: disabled Energy Ball should have been auto-replaced');
		}
	}
	console.log('OK: Encore + Torment -> Struggle, no timeout');
})().catch(err => {
	console.error('FAIL:', err);
	process.exitCode = 1;
});
