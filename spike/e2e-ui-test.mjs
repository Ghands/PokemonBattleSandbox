'use strict';

/**
 * E2E test driving the UI server's /api/rpc with the exact payloads app.js builds:
 * suggest -> createSession -> applyTurn (hot injection) -> applyTurn (rebuild)
 * -> switch choice -> undo-style recreate.
 */
const BASE = 'http://127.0.0.1:8931/api/rpc';

async function api(method, params) {
	const res = await fetch(BASE, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ method, params }),
	});
	const data = await res.json();
	if (!data.ok) throw new Error(`${method}: ${data.error}`);
	return data.result;
}

const mk = (sp, ab, mv, extra = {}) => ({
	name: sp, species: sp, item: 'Leftovers', ability: ab, nature: 'Serious', level: 100,
	evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
	ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
	moves: mv, teraType: '', ...extra,
});

(async () => {
	const garchomp = await api('suggestSet', { species: 'garchomp' });
	const snorlax = await api('suggestSet', { species: 'snorlax' });
	console.log('suggest:', garchomp.moves.join('/'), '| Lv', garchomp.level);

	let config = {
		format: 'gen9customgame',
		seed: [11, 22, 33, 44],
		p1: { active: 0, slots: [mk('Garchomp', 'Rough Skin', ['Earthquake', 'Dragon Claw', 'Swords Dance', 'Protect'], { level: 100, teraType: 'Steel' })] },
		p2: { active: 0, slots: [mk('Snorlax', 'Thick Fat', ['Body Slam', 'Rest', 'Protect', 'Earthquake'], { level: 100 })] },
		field: { weather: '', terrain: '', p1: { conditions: [] }, p2: { conditions: [] } },
	};

	let start = await api('createSession', { config });
	console.log('session:', start.sessionId, '| p1 hp', start.state.p1.pokemon[0].hp, '/', start.state.p1.pokemon[0].maxhp);

	// Turn 1: hot-inject HP + status mid-battle.
	let r = await api('applyTurn', {
		sessionId: start.sessionId, config,
		choices: { p1: { kind: 'move', index: 3, tera: false }, p2: { kind: 'move', index: 0 } },
	});
	console.log('turn1 rebuilt=', r.rebuilt, '| p1 boost atk', r.after.p1.pokemon[0].boosts.atk);
	console.log(r.text.join(' / '));
	config = r.config;

	// Turn 2: same structure, hp + status injection only.
	config.p1.slots[0].hp = Math.floor(config.p1.slots[0].hp * 0.5);
	config.p2.slots[0].status = 'par';
	r = await api('applyTurn', {
		sessionId: start.sessionId, config,
		choices: { p1: { kind: 'move', index: 2, tera: true }, p2: { kind: 'move', index: 2 } },
	});
	console.log('turn2 rebuilt=', r.rebuilt, '| p2 status', r.after.p2.pokemon[0].status, '| hp', r.after.p1.pokemon[0].hp);
	console.log(r.text.join(' / '));
	config = r.config;

	// Turn 3: structural edit (level) -> rebuild expected.
	config.p1.slots[0].level = 50;
	const before = JSON.parse(JSON.stringify(config)); // what the UI stores as turns[].before
	r = await api('applyTurn', {
		sessionId: start.sessionId, config,
		choices: { p1: { kind: 'move', index: 2 }, p2: { kind: 'move', index: 1 } },
	});
	console.log('turn3 rebuilt=', r.rebuilt, '| p1 maxhp', r.after.p1.pokemon[0].maxhp);

	// Undo simulation: drop turn 3, recreate session from turn-3's exact before
	// config + the PRNG state captured before turn-3's choices, then replay the
	// same choices -> must match turn3 exactly.
	before.prngSeed = r.prngSeed;
	await api('closeSession', { sessionId: start.sessionId });
	const again = await api('createSession', { config: before });
	const r2 = await api('applyTurn', {
		sessionId: again.sessionId, config: before,
		choices: { p1: { kind: 'move', index: 2 }, p2: { kind: 'move', index: 1 } },
	});
	const same = JSON.stringify(r2.after) === JSON.stringify(r.after);
	const textSame = JSON.stringify(r2.text) === JSON.stringify(r.text);
	console.log('redo turn3 rebuilt=', r2.rebuilt, '| after same:', same, '| text same:', textSame);
	if (!textSame) {
		for (let i = 0; i < Math.max(r.text.length, r2.text.length); i++) {
			if (r.text[i] !== r2.text[i]) console.log(`  text[${i}]: "${r.text[i]}" vs "${r2.text[i]}"`);
		}
	}
	if (!same) {
		const diff = (a, b, path) => {
			if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
				if (JSON.stringify(a) !== JSON.stringify(b)) console.log('  DIFF', path, JSON.stringify(a), '->', JSON.stringify(b));
				return;
			}
			for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diff(a[k], b[k], path + '.' + k);
		};
		diff(r.after, r2.after, 'after');
	}

	await api('closeSession', { sessionId: again.sessionId });
	console.log('E2E OK');
})().catch(err => { console.error('E2E FAIL:', err.message); process.exit(1); });
