'use strict';

const path = require('path');
const { BattleSession } = require(path.join(__dirname, '..', 'engine-host', 'lib', 'session.cjs'));

const engineDir = path.join(__dirname, '..', 'pokemon-showdown-master');
const mk = (species, ability, moves, extra = {}) => ({
	name: species, species, item: 'Leftovers', ability, nature: 'Serious', level: 100,
	evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0 },
	ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31 },
	moves, ...extra,
});

(async () => {
	const session = new BattleSession({ engineDir });
	const config = {
		format: 'gen9customgame',
		seed: [7, 8, 9, 10],
		p1: {
			active: 0,
			slots: [
				mk('Garchomp', 'Rough Skin', ['Earthquake', 'Dragon Claw', 'Stone Edge', 'Protect']),
				mk('Heatran', 'Flash Fire', ['Magma Storm', 'Earth Power', 'Protect', 'Stealth Rock'], { hpPercent: 50 }),
			],
		},
		p2: {
			active: 0,
			slots: [
				mk('Rotom-Wash', 'Levitate', ['Volt Switch', 'Hydro Pump', 'Will-O-Wisp', 'Protect']),
				mk('Corviknight', 'Pressure', ['Brave Bird', 'Roost', 'Defog', 'U-turn']),
			],
		},
		field: { weather: '', terrain: '', p1: { conditions: [] }, p2: { conditions: [] } },
	};
	await session.start(config);

	console.log('initial active p1:', session.readState().p1.active,
		'| bench hp:', session.readState().p1.pokemon[1].hp, '/', session.readState().p1.pokemon[1].maxhp);

	const r = await session.applyTurn({
		config,
		choices: {
			p1: { kind: 'switch', slot: 1 },
			p2: { kind: 'move', index: 3 },
		},
	});
	console.log('events:', r.events.filter(l => l.startsWith('|switch|') || l.startsWith('|move|') || l.startsWith('|faint|')));
	console.log('p1 active slot:', r.after.p1.active, '| activePos:', r.after.p1.activePos);
	console.log('p1 active mon:', r.after.p1.pokemon[r.after.p1.activePos].species,
		'r hp:', r.after.p1.pokemon[r.after.p1.activePos].hp, '/', r.after.p1.pokemon[r.after.p1.activePos].maxhp);
	console.log('p1 hazards:', r.after.field.p1.conditions);

	await session.close();
})().catch(err => {
	console.error(err);
	process.exit(1);
});
