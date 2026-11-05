'use strict';

const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const root = path.join(__dirname, '..');
const child = spawn(process.execPath, [path.join(root, 'engine-host', 'host.cjs')], {
	stdio: ['pipe', 'pipe', 'inherit'],
});

const rl = readline.createInterface({ input: child.stdout, terminal: false });
const pending = new Map();
let seq = 1;

rl.on('line', line => {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		console.error('bad line:', line.slice(0, 200));
		return;
	}
	const entry = pending.get(msg.id);
	if (!entry) return;
	pending.delete(msg.id);
	if (msg.ok) entry.resolve(msg.result);
	else entry.reject(new Error(msg.error));
});

function rpc(method, params = {}) {
	const id = seq++;
	const payload = JSON.stringify({ id, method, params });
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		child.stdin.write(payload + '\n');
	});
}

const garchomp = {
	name: 'Garchomp', species: 'Garchomp', item: 'Life Orb', ability: 'Rough Skin',
	nature: 'Jolly', level: 100,
	evs: { hp: 0, atk: 252, def: 0, spa: 0, spd: 4, spe: 252 },
	ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
	moves: ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Swords Dance'],
	teraType: 'Steel',
};
const heatran = {
	name: 'Heatran', species: 'Heatran', item: 'Leftovers', ability: 'Flash Fire',
	nature: 'Modest', level: 100,
	evs: { hp: 252, atk: 0, def: 0, spa: 252, spd: 4, spe: 0 },
	ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
	moves: ['Magma Storm', 'Earth Power', 'Protect', 'Stealth Rock'],
	teraType: 'Fire',
};

(async () => {
	const probe = await rpc('probe');
	console.log('probe:', probe.engineVersion, '| species', probe.speciesCount, '| moves', probe.moveCount);
	console.log('formats:', probe.formats.slice(0, 4).map(f => f.id).join(', '), '...');

	const cat = await rpc('catalog');
	console.log('catalog:', cat.species.length, 'species,', cat.moves.length, 'moves,', cat.items.length, 'items');
	const g = cat.species.find(s => s.id === 'garchomp');
	console.log('garchomp:', g.name, '/', g.nameZh, '| types', g.types.join('/'), '| atk', g.baseStats.atk);

	const auto = await rpc('suggestSet', { species: 'garchomp' });
	console.log('auto set:', auto.ability, '|', auto.item, '|', auto.moves.join(', '), '| Lv', auto.level);

	const start = await rpc('createSession', {
		config: {
			format: 'gen9customgame',
			seed: [11, 22, 33, 44],
			p1: { active: 0, slots: [garchomp] },
			p2: { active: 0, slots: [heatran] },
			field: { weather: 'sun', terrain: '', p1: { conditions: [] }, p2: { conditions: [] } },
		},
	});
	console.log('session:', start.sessionId, '| initial p1 stats', start.requests.p1.side.pokemon[0].stats);

	let config = start.config;
	let turn = await rpc('applyTurn', {
		sessionId: start.sessionId,
		config,
		choices: { p1: { kind: 'move', index: 3 }, p2: { kind: 'move', index: 3 } },
	});
	console.log(`\n--- turn ${turn.turn} (rebuilt=${turn.rebuilt}) ---`);
	console.log(turn.text.join('\n'));
	config = turn.config;

	config.p1.slots[0].hpPercent = 40;
	config.p2.slots[0].status = 'par';
	turn = await rpc('applyTurn', {
		sessionId: start.sessionId,
		config,
		choices: { p1: { kind: 'move', index: 0 }, p2: { kind: 'move', index: 2 } },
	});
	console.log(`\n--- turn ${turn.turn} (rebuilt=${turn.rebuilt}) ---`);
	console.log(turn.text.join('\n'));
	console.log('p1 hp:', turn.after.p1.pokemon[0].hp, '/', turn.after.p1.pokemon[0].maxhp,
		'| atk boost:', turn.after.p1.pokemon[0].boosts.atk,
		'| p2 status:', turn.after.p2.pokemon[0].status);
	config = turn.config;

	// Structural edit -> rebuild; status edit stays hot.
	config.p1.slots[0].level = 50;
	config.p2.slots[0].status = 'par';
	turn = await rpc('applyTurn', {
		sessionId: start.sessionId,
		config,
		choices: { p1: { kind: 'move', index: 3 }, p2: { kind: 'move', index: 2 } },
	});
	console.log(`\n--- turn ${turn.turn} (rebuilt=${turn.rebuilt}) ---`);
	console.log(turn.text.join('\n'));
	console.log('p1 maxhp:', turn.after.p1.pokemon[0].maxhp,
		'| atk boost:', turn.after.p1.pokemon[0].boosts.atk,
		'| p2 status:', turn.after.p2.pokemon[0].status);

	await rpc('closeSession', { sessionId: start.sessionId });
	child.stdin.end();
	child.kill();
})().catch(err => {
	console.error(err);
	child.kill();
	process.exit(1);
});
