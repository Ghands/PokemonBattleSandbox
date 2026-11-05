#!/usr/bin/env node
/**
 * Minimal engine host for the local Pokemon battle sandbox.
 *
 * Protocol: one JSON object per line on stdin/stdout.
 *   request  { id, method, params }
 *   response { id, ok, result } | { id, ok: false, error }
 *
 * Methods:
 *   probe        -> engine/data version, formats, counts
 *   catalog      -> species/moves/items/abilities/natures for editors
 *   createSession-> { sessionId, state, requests, config }
 *   applyTurn    -> { turn, rebuilt, ended, events, text, after, requests, config }
 *   closeSession -> true
 */
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { BattleSession, loadEngine } = require(path.join(__dirname, 'lib', 'session.cjs'));
const { formatEvents } = require(path.join(__dirname, 'lib', 'format.cjs'));

function parseArgs(argv) {
	// PBSIM_ENGINE is the in-process entry point (no argv available when the
	// host is required from the Electron main process). --engine still wins.
	const out = {
		engine: process.env.PBSIM_ENGINE
			? path.resolve(process.env.PBSIM_ENGINE)
			: path.join(__dirname, '..', 'pokemon-showdown-master'),
	};
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === '--engine') out.engine = path.resolve(argv[++i]);
	}
	return out;
}

const args = parseArgs(process.argv.slice(2));
const engineDir = args.engine;

function enginePackage() {
	const file = path.join(engineDir, 'package.json');
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadZh() {
	const dir = path.join(engineDir, 'dist', 'data', 'text', 'zh-cn');
	const pick = (file, key) => {
		try {
			return require(path.join(dir, file))[key] || {};
		} catch {
			return {};
		}
	};
	return {
		species: pick('pokedex.js', 'PokedexText'),
		moves: pick('moves.js', 'MovesText'),
		items: pick('items.js', 'ItemsText'),
		abilities: pick('abilities.js', 'AbilitiesText'),
	};
}

let zhCache = null;
function zh() {
	if (!zhCache) zhCache = loadZh();
	return zhCache;
}

function probe() {
	const Sim = loadEngine(engineDir);
	const pkg = enginePackage();
	const formats = [];
	for (let gen = 1; gen <= 9; gen++) {
		for (const suffix of ['customgame', 'doublescustomgame']) {
			const id = `gen${gen}${suffix}`;
			if (Sim.Dex.formats.get(id).exists) {
				formats.push({
					id,
					label: `第 ${gen} 世代${suffix === 'customgame' ? '单打' : '双打'}（自由配置）`,
					doubles: suffix !== 'customgame',
					supported: suffix === 'customgame',
				});
			}
		}
	}
	return {
		engine: pkg.name,
		engineVersion: pkg.version,
		node: process.version,
		engineDir,
		dataMtime: fs.statSync(path.join(engineDir, 'dist', 'data')).mtime.toISOString(),
		speciesCount: Sim.Dex.species.all().length,
		moveCount: Sim.Dex.moves.all().length,
		formats,
	};
}

// Conditions whose English id collides with an unrelated move/species name.
const VOLATILE_ZH_FIX = {
	confusion: '混乱', flinch: '畏缩', trapped: '无法逃走', trapper: '束缚者',
	partiallytrapped: '部分束缚', lockedmove: '锁定招式', twoturnmove: '蓄力中',
	choicelock: '讲究锁招', mustrecharge: '需要休息', futuremove: '预知未来',
	healreplacement: '治愈愿望待命', stall: '守住连发衰减', gem: '宝石',
	dynamax: '极巨化', rolloutstorage: '滚动蓄力', commanded: '受指挥',
	commanding: '指挥中', substitute: '替身', leechseed: '寄生种子',
};

// Volatiles a player most often wants to toggle by hand.
const COMMON_VOLATILES = [
	'substitute', 'leechseed', 'taunt', 'encore', 'confusion', 'attract', 'disable',
	'yawn', 'perishsong', 'destinybond', 'curse', 'ingrain', 'roost', 'magnetrise',
	'saltcure', 'partiallytrapped', 'torment', 'throatchop', 'embargo', 'healblock',
	'imprison', 'minimize', 'protect', 'focusenergy', 'aquaring', 'stockpile',
	'tarshot', 'smackdown', 'telekinesis', 'charge', 'flinch', 'choicelock',
];

let catalogCache = null;
let namesCache = null;
function nameMaps() {
	if (!namesCache) {
		const cat = catalog();
		const species = {};
		const moves = {};
		for (const s of cat.species) if (s.nameZh) species[s.name] = s.nameZh;
		for (const m of cat.moves) if (m.nameZh) moves[m.name] = m.nameZh;
		namesCache = { species, moves };
	}
	return namesCache;
}

function catalog() {
	if (catalogCache) return catalogCache;
	const Sim = loadEngine(engineDir);
	const t = zh();
	const dex = Sim.Dex;

	const species = dex.species.all().filter(s => s.exists).map(s => ({
		id: s.id,
		name: s.name,
		nameZh: t.species[s.id]?.name || null,
		num: s.num,
		gen: s.gen,
		types: s.types,
		baseStats: s.baseStats,
		abilities: s.abilities,
		isNonstandard: s.isNonstandard || null,
		forme: s.forme || '',
	}));

	const moves = dex.moves.all().filter(m => m.exists).map(m => ({
		id: m.id,
		name: m.name,
		nameZh: t.moves[m.id]?.name || null,
		type: m.type,
		category: m.category,
		power: m.basePower,
		accuracy: m.accuracy,
		pp: m.pp,
		priority: m.priority,
		gen: m.gen,
		isNonstandard: m.isNonstandard || null,
	}));

	const items = dex.items.all().filter(i => i.exists).map(i => ({
		id: i.id,
		name: i.name,
		nameZh: t.items[i.id]?.name || null,
		gen: i.gen,
		isNonstandard: i.isNonstandard || null,
	}));

	const abilities = dex.abilities.all().filter(a => a.exists).map(a => ({
		id: a.id,
		name: a.name,
		nameZh: t.abilities[a.id]?.name || null,
		gen: a.gen,
		isNonstandard: a.isNonstandard || null,
	}));

	const natures = dex.natures.all().filter(n => n.exists).map(n => ({
		id: n.id,
		name: n.name,
		plus: n.plus || '',
		minus: n.minus || '',
	}));

	catalogCache = {
		species, moves, items, abilities, natures,
		volatiles: volatileCatalog(dex, t),
		commonVolatiles: COMMON_VOLATILES,
	};
	return catalogCache;
}

/**
 * Volatile (per-Pokemon) conditions the engine can carry.
 *
 * Built from two sources: the shared Conditions table (confusion, trapped, ...)
 * and every move / ability that registers its own condition. Side and field
 * conditions are dropped because they belong to the field editor instead.
 */
function volatileCatalog(dex, t) {
	const skipTypes = new Set(['Status', 'Weather', 'Terrain']);
	const seen = new Map(); // id -> 'condition' | 'move' | 'ability'
	const add = (id, kind) => { if (id && !seen.has(id)) seen.set(id, kind); };

	for (const [id, cond] of Object.entries(dex.data.Conditions || {})) {
		if (skipTypes.has(cond.effectType)) continue;
		add(id, 'condition');
	}
	for (const move of dex.moves.all()) {
		if (!move.exists || move.isMax) continue;
		if (move.volatileStatus) add(move.volatileStatus, 'move');
		if (move.sideCondition || move.pseudoWeather || move.weather || move.terrain || move.slotCondition) continue;
		const cond = dex.conditions.get(move.id);
		if (cond.exists && cond.effectType === 'Condition' && cond.name !== '???') add(move.id, 'move');
	}
	for (const ability of dex.abilities.all()) {
		if (!ability.exists) continue;
		const cond = dex.conditions.get(ability.id);
		if (cond.exists && cond.effectType === 'Condition') add(ability.id, 'ability');
	}

	const out = [];
	for (const [id, kind] of seen) {
		const cond = dex.conditions.get(id);
		if (!cond.exists || cond.isNonstandard === 'Custom') continue;
		// Species-bound conditions (Arceus/Silvally/Zacian/...) are forme data,
		// not something a Pokemon can be given mid-battle.
		if (dex.species.get(id).exists && !VOLATILE_ZH_FIX[id]) continue;
		const move = dex.moves.get(id);
		const nameZh = VOLATILE_ZH_FIX[id] || t.moves[id]?.name || t.abilities[id]?.name || null;
		out.push({
			id,
			name: move.exists ? move.name : cond.name,
			nameZh,
			kind,
			isNonstandard: cond.isNonstandard || null,
		});
	}
	out.sort((a, b) => (a.nameZh ? 0 : 1) - (b.nameZh ? 0 : 1) || a.id.localeCompare(b.id));
	return out;
}

function mergeAfter(config, after) {
	const next = JSON.parse(JSON.stringify(config));
	for (const side of ['p1', 'p2']) {
		next[side].active = after[side].active;
		for (const mon of after[side].pokemon) {
			const slot = next[side].slots?.[mon.slot];
			if (!slot) continue;
			slot.hp = mon.hp;
			slot.hpPercent = undefined;
			slot.status = mon.status;
			slot.boosts = { ...mon.boosts };
			slot.pp = Object.fromEntries(mon.moves.map(m => [m.id, m.pp]));
			slot.volatiles = [...mon.volatiles];
		}
	}
	next.field = {
		weather: after.field.weather,
		terrain: after.field.terrain,
		p1: { conditions: [...after.field.p1.conditions] },
		p2: { conditions: [...after.field.p2.conditions] },
	};
	return next;
}

const sessions = new Map();
let nextSessionId = 1;

async function handle(method, params = {}) {
	switch (method) {
	case 'probe':
		return probe();
	case 'catalog':
		return catalog();
	case 'suggestSet': {
		const Sim = loadEngine(engineDir);
		const generatorFormat = params.generatorFormat || 'gen9randombattle';
		const format = Sim.Dex.formats.get(generatorFormat);
		if (!format.exists) throw new Error(`unknown generator format: ${generatorFormat}`);
		const gen = Sim.Teams.getGenerator(format, params.seed || [1, 2, 3, 4]);
		const set = gen.randomSet(params.species, {}, false);
		if (!set) throw new Error(`no auto set for ${params.species}`);
		return {
			species: Sim.Dex.species.get(set.species).name,
			level: set.level,
			item: set.item ? Sim.Dex.items.get(set.item).name : '',
			ability: set.ability ? Sim.Dex.abilities.get(set.ability).name : '',
			nature: set.nature || 'Serious',
			evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(set.evs || {}) },
			ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(set.ivs || {}) },
			moves: (set.moves || []).map(m => Sim.Dex.moves.get(m).name),
			teraType: set.teraType || '',
		};
	}
	case 'createSession': {
		const config = params.config;
		if (!config) throw new Error('createSession requires params.config');
		const session = new BattleSession({ engineDir });
		await session.start(config);
		const id = `s${nextSessionId++}`;
		sessions.set(id, session);
		return {
			sessionId: id,
			turn: 0,
			state: session.readState(),
			requests: session.requests,
			config,
		};
	}
	case 'applyTurn': {
		const session = sessions.get(params.sessionId);
		if (!session) throw new Error(`unknown session: ${params.sessionId}`);
		const result = await session.applyTurn({
			config: params.config,
			choices: params.choices || {},
		});
		return {
			...result,
			text: formatEvents(result.events, nameMaps(), result.before),
			config: mergeAfter(params.config, result.after),
		};
	}
	case 'closeSession': {
		const session = sessions.get(params.sessionId);
		if (session) {
			await session.close();
			sessions.delete(params.sessionId);
		}
		return true;
	}
	case 'shutdown': {
		for (const session of sessions.values()) await session.close();
		sessions.clear();
		// Only the standalone stdio process exits. In-process callers just
		// want the sessions cleaned up.
		if (require.main === module) setImmediate(() => process.exit(0));
		return true;
	}
	default:
		throw new Error(`unknown method: ${method}`);
	}
}

// Exporting `handle` lets the Electron main process run the engine in-process.
// This matters on HarmonyOS: a HAP may not be allowed to re-exec its own
// binary with ELECTRON_RUN_AS_NODE, and the engine is pure JS anyway.
module.exports = { handle, engineDir };

if (require.main === module) {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	let chain = Promise.resolve();

	rl.on('line', line => {
		line = line.trim();
		if (!line) return;
		chain = chain.then(async () => {
			let msg = null;
			try {
				msg = JSON.parse(line);
				const result = await handle(msg.method, msg.params);
				process.stdout.write(JSON.stringify({ id: msg.id ?? null, ok: true, result }) + '\n');
			} catch (err) {
				process.stdout.write(JSON.stringify({
					id: msg?.id ?? null,
					ok: false,
					error: err.message,
					stack: process.env.PBSIM_DEBUG ? err.stack : undefined,
				}) + '\n');
			}
		});
	});

	rl.on('close', async () => {
		for (const session of sessions.values()) {
			try { await session.close(); } catch {}
		}
	});
}
