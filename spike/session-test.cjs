'use strict';

const path = require('path');
const { BattleSession } = require(path.join(__dirname, '..', 'engine-host', 'lib', 'session.cjs'));

const engineDir = path.join(__dirname, '..', 'pokemon-showdown-master');

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

function initialConfig() {
	return {
		format: 'gen9customgame',
		seed: [11, 22, 33, 44],
		p1: { active: 0, slots: [JSON.parse(JSON.stringify(garchomp))] },
		p2: { active: 0, slots: [JSON.parse(JSON.stringify(heatran))] },
		field: { weather: 'sun', terrain: '', p1: { conditions: [] }, p2: { conditions: [] } },
	};
}

/** Copy engine state back into the editable config. */
function sync(config, after) {
	for (const side of ['p1', 'p2']) {
		config[side].active = after[side].active;
		for (const mon of after[side].pokemon) {
			const slot = config[side].slots[mon.slot];
			slot.hp = mon.hp;
			slot.status = mon.status;
			slot.boosts = { ...mon.boosts };
			slot.pp = Object.fromEntries(mon.moves.map(m => [m.id, m.pp]));
			slot.volatiles = [...mon.volatiles];
		}
	}
	config.field = {
		weather: after.field.weather,
		terrain: after.field.terrain,
		p1: { conditions: [...after.field.p1.conditions] },
		p2: { conditions: [...after.field.p2.conditions] },
	};
	return config;
}

function pretty(events, turn) {
	const out = [`\n=== 第 ${turn} 回合 ===`];
	for (const line of events) {
		const p = line.split('|');
		switch (p[1]) {
		case 'turn': break;
		case 'move': out.push(`  ${p[2]} 使用 ${p[3]}！`); break;
		case 'switch': out.push(`  ${p[2]} 换上 ${p[3]}`); break;
		case '-damage': out.push(`  ${p[2]} → ${p[3]}`); break;
		case '-heal': out.push(`  ${p[2]} 回复 → ${p[3]}`); break;
		case '-status': out.push(`  ${p[2]} 状态 ${p[3]}`); break;
		case '-boost': out.push(`  ${p[2]} ${p[3]} +${p[4]}`); break;
		case '-unboost': out.push(`  ${p[2]} ${p[3]} -${p[4]}`); break;
		case '-crit': out.push('  击中要害！'); break;
		case '-supereffective': out.push('  效果绝佳！'); break;
		case '-resisted': out.push('  效果不佳…'); break;
		case '-immune': out.push('  没有效果…'); break;
		case '-miss': out.push('  没有命中…'); break;
		case 'faint': out.push(`  ${p[2]} 倒下了！`); break;
		case 'win': out.push(`  ${p[2]} 获胜`); break;
		case 'cant': out.push(`  ${p[2]} 无法行动（${p[3]}）`); break;
		case '-weather': out.push(`  天气变为 ${p[2]}`); break;
		case '-fieldstart': out.push(`  场地 ${p[2]}`); break;
		case '-sidestart': out.push(`  ${p[2]} 展开 ${p[3]}`); break;
		case '-sideend': out.push(`  ${p[2]} 的 ${p[3]} 结束`); break;
		case '-activate': out.push(`  ${p[2]} 发动 ${p[3]}`); break;
		case '-enditem': out.push(`  ${p[2]} 失去 ${p[3]}`); break;
		case '-ability': out.push(`  ${p[2]} 特性：${p[3]}`); break;
		case 'upkeep': break;
		default:
			if (p[1] && !['t:', 'html', 'player', 'teamsize', 'gametype', 'gen', 'tier', 'rule', 'clearpoke', 'poke', 'teampreview', 'start'].includes(p[1])) {
				out.push(`  ${line}`);
			}
		}
	}
	return out.join('\n');
}

async function run() {
	const session = new BattleSession({ engineDir });
	const config = initialConfig();
	await session.start(config);

	const s1 = await session.applyTurn({
		config,
		choices: { p1: { kind: 'move', index: 3 }, p2: { kind: 'move', index: 3 } },
	});
	console.log(pretty(s1.events, s1.turn));
	sync(config, s1.after);
	console.log('  after: p1 atk =', s1.after.p1.pokemon[0].boosts.atk,
		'| p1 hazards =', s1.after.p1.conditions,
		'| SD pp =', s1.after.p1.pokemon[0].moves[3].pp);

	// Hot patch: lower HP without rebuilding.
	config.p1.slots[0].hpPercent = 40;
	const s2 = await session.applyTurn({
		config,
		choices: { p1: { kind: 'move', index: 0 }, p2: { kind: 'move', index: 2 } },
	});
	console.log(pretty(s2.events, s2.turn));
	console.log('  rebuilt =', s2.rebuilt, '| p1 hp =', s2.after.p1.pokemon[0].hp, '/', s2.after.p1.pokemon[0].maxhp,
		'| atk boost =', s2.after.p1.pokemon[0].boosts.atk);
	sync(config, s2.after);

	// Structural patch: change level -> should rebuild.
	config.p1.slots[0].level = 50;
	const s3 = await session.applyTurn({
		config,
		choices: { p1: { kind: 'move', index: 0 }, p2: { kind: 'move', index: 1 } },
	});
	console.log(pretty(s3.events, s3.turn));
	console.log('  rebuilt =', s3.rebuilt, '| p1 hp =', s3.after.p1.pokemon[0].hp, '/', s3.after.p1.pokemon[0].maxhp,
		'| level =', s3.after.p1.pokemon[0].level, '| atk boost =', s3.after.p1.pokemon[0].boosts.atk);
	sync(config, s3.after);

	await session.close();
	return { s1, s2, s3 };
}

(async () => {
	const a = await run();
	const b = await run();
	const same = JSON.stringify(a) === JSON.stringify(b);
	console.log('\n=== 确定性 ===');
	console.log(same ? 'OK：两次完整会话完全一致' : 'FAIL：两次会话不一致');
	if (!same) process.exitCode = 1;
})().catch(err => {
	console.error(err);
	process.exit(1);
});
