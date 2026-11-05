'use strict';

/* ---------------------------------------------------------------- *
 * 宝可梦对战沙盘 —— 三栏纯文本 UI
 * 左右：双方参数面板；中间：场地 + 回合卡
 * ---------------------------------------------------------------- */

const $ = s => document.querySelector(s);

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const BOOST_KEYS = ['atk', 'def', 'spa', 'spd', 'spe', 'accuracy', 'evasion'];
const STAT_ZH = {
	hp: 'HP', atk: '攻击', def: '防御', spa: '特攻', spd: '特防',
	spe: '速度', accuracy: '命中', evasion: '闪避',
};
const TYPE_ZH = {
	Normal: '一般', Fire: '火', Water: '水', Grass: '草', Electric: '电', Ice: '冰',
	Fighting: '格斗', Poison: '毒', Ground: '地面', Flying: '飞行', Psychic: '超能力',
	Bug: '虫', Rock: '岩石', Ghost: '幽灵', Dragon: '龙', Dark: '恶', Steel: '钢', Fairy: '妖精',
};
const STATUS_OPTS = [
	['', '无'], ['brn', '灼伤'], ['par', '麻痹'], ['psn', '中毒'],
	['tox', '剧毒'], ['slp', '睡眠'], ['frz', '冰冻'],
];
const STATUS_ZH = Object.fromEntries(STATUS_OPTS);
const NATURE_ZH = {
	Hardy: '勤奋', Lonely: '怕寂寞', Brave: '勇敢', Adamant: '固执', Naughty: '顽皮',
	Bold: '大胆', Docile: '坦率', Relaxed: '悠闲', Impish: '淘气', Lax: '乐天',
	Timid: '胆小', Hasty: '急躁', Serious: '认真', Jolly: '开朗', Naive: '天真',
	Modest: '内敛', Mild: '慢吞吞', Quiet: '冷静', Bashful: '害羞', Rash: '马虎',
	Calm: '温和', Gentle: '温顺', Sassy: '自大', Careful: '慎重', Quirky: '浮躁',
};
const WEATHER_OPTS = [
	['', '无天气'], ['sunnyday', '大晴天'], ['raindance', '下雨'], ['sandstorm', '沙暴'],
	['hail', '冰雹'], ['snowscape', '下雪'], ['deltastream', '乱流'],
	['desolateland', '大日照'], ['primordialsea', '大降雨'],
];
const TERRAIN_OPTS = [
	['', '无场地'], ['electricterrain', '电气场地'], ['grassyterrain', '青草场地'],
	['mistyterrain', '薄雾场地'], ['psychicterrain', '精神场地'],
];
const SIDE_COND_OPTS = [
	['stealthrock', '隐形岩'], ['spikes', '撒菱'], ['toxicspikes', '毒菱'], ['stickyweb', '黏黏网'],
	['reflect', '反射壁'], ['lightscreen', '光墙'], ['auroraveil', '极光幕'],
	['tailwind', '顺风'], ['safeguard', '神秘守护'],
];
const TYPES = Object.keys(TYPE_ZH);

const zero = keys => Object.fromEntries(keys.map(k => [k, 0]));
const clone = v => JSON.parse(JSON.stringify(v));
const randSeed = () => [1, 2, 3, 4].map(() => Math.floor(Math.random() * 65536));

/* ------------------------------ state ------------------------------ */

let PROBE = null;
let CATALOG = null;
let byName = { species: {}, moves: {}, items: {}, abilities: {} };
let byVolatile = new Map();

let state = null;

function blankAction() {
	return { kind: 'move', index: 0, tera: false, switchSlot: null };
}
function blankSlot() {
	return {
		species: '', item: '', ability: '', nature: 'Serious', level: 100, gender: '',
		evs: zero(STAT_KEYS), ivs: Object.fromEntries(STAT_KEYS.map(k => [k, 31])),
		moves: ['', '', '', ''], teraType: '',
		hp: null, status: '', boosts: zero(BOOST_KEYS), pp: {}, volatiles: [],
	};
}
// Per-side display switches, edited on the settings sheet.
const SHOW_FIELDS = [
	['evs', '努力值（EV）'],
	['ivs', '个体值（IV）'],
	['boosts', '能力变化（等级）'],
	['stats', '六维数值汇总'],
];
function blankShow() {
	return Object.fromEntries(SHOW_FIELDS.map(([k]) => [k, true]));
}

function blankState() {
	return {
		format: 'gen9customgame',
		seed: randSeed(),
		pendingPrngSeed: null,
		show: { p1: blankShow(), p2: blankShow() },
		field: { weather: '', terrain: '', p1: { conditions: [] }, p2: { conditions: [] } },
		p1: { active: 0, slots: [blankSlot()] },
		p2: { active: 0, slots: [blankSlot()] },
		sel: { p1: 0, p2: 0 },
		action: { p1: blankAction(), p2: blankAction() },
		sessionId: null,
		ended: false,
		turns: [],
	};
}

/* ------------------------------ dom helpers ------------------------------ */

function el(tag, attrs, ...children) {
	const node = document.createElement(tag);
	if (attrs) for (const [k, v] of Object.entries(attrs)) {
		if (v === undefined || v === null || v === false) continue;
		if (k === 'class') node.className = v;
		else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
		else if (k === 'checked' || k === 'selected' || k === 'disabled' || k === 'hidden') {
			if (v === true) node[k] = true;
		} else if (k === 'value') node.value = v;
		else node.setAttribute(k, v);
	}
	for (const child of children.flat()) {
		if (child === null || child === undefined || child === false) continue;
		node.append(child.nodeType ? child : document.createTextNode(child));
	}
	return node;
}

function numInput(value, opt, onchange) {
	const input = el('input', { type: 'number', value: value ?? '' });
	if (opt) {
		if (opt.min !== undefined) input.min = opt.min;
		if (opt.max !== undefined) input.max = opt.max;
	}
	input.addEventListener('change', () => {
		const n = input.value === '' ? null : Number(input.value);
		if (n !== null && opt && opt.min !== undefined && n < opt.min) { input.value = opt.min; }
		if (n !== null && opt && opt.max !== undefined && n > opt.max) { input.value = opt.max; }
		onchange(input.value === '' ? null : Number(input.value));
	});
	return input;
}
function select(options, value, onchange) {
	const s = el('select');
	for (const [val, label] of options) s.append(el('option', { value: val }, label));
	s.value = value;
	s.addEventListener('change', () => onchange(s.value));
	return s;
}
function check(checked, onchange, label) {
	const c = el('input', { type: 'checkbox' });
	c.checked = !!checked;
	c.addEventListener('change', () => onchange(c.checked));
	return label === undefined ? c : el('label', null, c, ' ', label);
}

/* ------------------------------ combo box ------------------------------ */

function combo({ value, placeholder, getItems, onPick, render, disabled }) {
	const wrap = el('div', { class: 'combo' });
	const input = el('input', { type: 'text', value: value || '', placeholder: placeholder || '搜索…' });
	if (disabled) input.disabled = true;
	let pop = null;

	const hide = () => { if (pop) { pop.remove(); pop = null; } };
	const pick = it => { hide(); input.value = ''; onPick(it); };

	const show = () => {
		hide();
		const filter = input.value.trim().toLowerCase();
		const items = getItems(filter);
		if (!items.length) return;
		pop = el('div', { class: 'pop' });
		for (const it of items) {
			const row = el('div', null, render(it));
			row.addEventListener('mousedown', e => { e.preventDefault(); pick(it); });
			pop.append(row);
		}
		wrap.append(pop);
	};
	input.addEventListener('focus', () => { show(); input.select(); });
	input.addEventListener('input', show);
	input.addEventListener('blur', () => setTimeout(hide, 150));
	wrap.append(input);
	return wrap;
}

const speciesLabel = s => s.nameZh ? `${s.nameZh}（${s.name}）` : s.name;
const moveLabel = m => `${m.nameZh || m.name}（${TYPE_ZH[m.type] || m.type}${m.power ? ` ${m.power}` : ' 变化'}）`;
const itemLabel = i => i.nameZh ? `${i.nameZh}（${i.name}）` : i.name;

// Displayed value after picking: Chinese name first, English as fallback.
const speciesDisplay = name => byName.species[name]?.nameZh || name || '';
const moveDisplay = name => byName.moves[name]?.nameZh || name || '';
const itemDisplay = name => byName.items[name]?.nameZh || name || '';

/* ------------------------------ api ------------------------------ */

async function api(method, params) {
	// Electron shell: main-process bridge over IPC (no localhost server).
	if (window.pbsim?.rpc) {
		const data = await window.pbsim.rpc(method, params || {});
		if (!data.ok) throw new Error(data.error || 'unknown error');
		return data.result;
	}
	// Browser dev mode: dev server endpoint.
	const res = await fetch('/api/rpc', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ method, params: params || {} }),
	});
	const data = await res.json();
	if (!data.ok) throw new Error(data.error || 'unknown error');
	return data.result;
}

// App-level (non-engine) IPC: settings, engine location and updates. The
// browser dev server has no equivalent, so those features degrade gracefully.
async function appApi(method, params) {
	if (!window.pbsim?.app) throw new Error('此功能仅在桌面应用中可用');
	const res = await window.pbsim.app(method, params || {});
	if (!res.ok) throw new Error(res.error || '操作失败');
	return res.result;
}

let toastTimer = null;
function toast(msg, isErr) {
	const t = $('#toast');
	t.textContent = msg;
	t.className = isErr ? 'err' : '';
	t.hidden = false;
	clearTimeout(toastTimer);
	toastTimer = setTimeout(() => { t.hidden = true; }, isErr ? 5000 : 2500);
}

/* ------------------------------ config build/restore ------------------------------ */

const SLOT_FIELDS = ['species', 'item', 'ability', 'nature', 'level', 'gender', 'teraType'];

function buildConfig() {
	const mkSide = side => ({
		active: Math.min(state[side].active, state[side].slots.length - 1),
		slots: state[side].slots.map(s => ({
			name: s.species,
			species: s.species,
			item: s.item || '',
			ability: s.ability || '',
			nature: s.nature || 'Serious',
			level: s.level || 100,
			gender: s.gender || '',
			evs: { ...s.evs },
			ivs: { ...s.ivs },
			moves: s.moves.filter(Boolean),
			teraType: s.teraType || '',
			hp: s.hp === null || s.hp === undefined ? undefined : s.hp,
			status: s.status || '',
			boosts: { ...s.boosts },
			pp: { ...(s.pp || {}) },
			volatiles: [...(s.volatiles || [])],
		})),
	});
	return {
		format: state.format,
		seed: [...state.seed],
		...(state.pendingPrngSeed ? { prngSeed: state.pendingPrngSeed } : {}),
		p1: mkSide('p1'),
		p2: mkSide('p2'),
		field: {
			weather: state.field.weather || '',
			terrain: state.field.terrain || '',
			p1: { conditions: [...state.field.p1.conditions] },
			p2: { conditions: [...state.field.p2.conditions] },
		},
	};
}

function restoreSlotFrom(ui, cfg) {
	if (!cfg) return;
	for (const k of SLOT_FIELDS) if (cfg[k] !== undefined) ui[k] = cfg[k];
	ui.evs = { ...zero(STAT_KEYS), ...(cfg.evs || {}) };
	ui.ivs = { ...Object.fromEntries(STAT_KEYS.map(k => [k, 31])), ...(cfg.ivs || {}) };
	ui.moves = [...(cfg.moves || []), '', '', '', ''].slice(0, 4);
	ui.hp = cfg.hp === undefined ? null : cfg.hp;
	ui.status = cfg.status || '';
	ui.boosts = { ...zero(BOOST_KEYS), ...(cfg.boosts || {}) };
	ui.pp = { ...(cfg.pp || {}) };
	ui.volatiles = [...(cfg.volatiles || [])];
}

function applyMergedConfig(cfg) {
	state.field = {
		weather: cfg.field.weather || '',
		terrain: cfg.field.terrain || '',
		p1: { conditions: [...(cfg.field.p1?.conditions || [])] },
		p2: { conditions: [...(cfg.field.p2?.conditions || [])] },
	};
	for (const side of ['p1', 'p2']) {
		state[side].active = Math.max(0, Math.min(cfg[side].active ?? 0, state[side].slots.length - 1));
		cfg[side].slots.forEach((s, i) => { if (state[side].slots[i]) restoreSlotFrom(state[side].slots[i], s); });
	}
}

/* ------------------------------ stats ------------------------------ */

function calcStats(slot) {
	const sp = byName.species[slot.species];
	if (!sp) return null;
	const L = slot.level || 100;
	const nat = CATALOG.natures.find(n => n.name === slot.nature) || { plus: '', minus: '' };
	const calc = key => {
		const base = sp.baseStats[key];
		let v = Math.floor((2 * base + (slot.ivs[key] ?? 31) + Math.floor((slot.evs[key] || 0) / 4)) * L / 100) + 5;
		if (nat.plus === key) v = Math.trunc(v * 1.1);
		if (nat.minus === key) v = Math.trunc(v * 0.9);
		return v;
	};
	return {
		hp: Math.floor((2 * sp.baseStats.hp + (slot.ivs.hp ?? 31) + Math.floor((slot.evs.hp || 0) / 4)) * L / 100) + L + 10,
		atk: calc('atk'), def: calc('def'), spa: calc('spa'), spd: calc('spd'), spe: calc('spe'),
	};
}

/* ------------------------------ turn engine glue ------------------------------ */

async function ensureSession() {
	if (state.sessionId) return buildConfig();
	const config = buildConfig();
	const res = await api('createSession', { config });
	state.sessionId = res.sessionId;
	return config;
}

async function recreateSession() {
	if (state.sessionId) {
		try { await api('closeSession', { sessionId: state.sessionId }); } catch { /* already gone */ }
	}
	state.sessionId = null;
	const config = buildConfig();
	const res = await api('createSession', { config });
	state.sessionId = res.sessionId;
	return config;
}

function choiceOf(side) {
	const a = state.action[side];
	const slot = state[side].slots[state[side].active];
	const moveCount = slot ? slot.moves.filter(Boolean).length : 0;
	if (a.switchSlot !== null && a.switchSlot !== undefined && a.switchSlot !== state[side].active &&
		a.switchSlot < state[side].slots.length) {
		return { kind: 'switch', slot: a.switchSlot };
	}
	return { kind: 'move', index: Math.min(a.index, Math.max(0, moveCount - 1)), tera: !!a.tera };
}

function ready() {
	for (const side of ['p1', 'p2']) {
		const slot = state[side].slots[state[side].active];
		if (!slot || !slot.species || !slot.moves.filter(Boolean).length) return false;
	}
	return true;
}

async function resolveTurn() {
	if (!ready()) return toast('双方上场的宝可梦需要物种和至少一个招式', true);
	try {
		const config = await ensureSession();
		const choices = { p1: choiceOf('p1'), p2: choiceOf('p2') };
		let res;
		try {
			res = await api('applyTurn', { sessionId: state.sessionId, config, choices });
		} catch (err) {
			if (/unknown session/.test(err.message)) {
				// host restarted or session dropped: rebuild once and retry
				const retryConfig = await recreateSession();
			res = await api('applyTurn', { sessionId: state.sessionId, config: retryConfig, choices });
			} else {
				throw err;
			}
		}
		state.turns.push({
			turn: res.turn,
			choices,
			before: clone(config),
			text: res.text,
			prng: res.prngSeed || null,
			meta: {
				rebuilt: res.rebuilt,
				ended: res.ended,
				warnings: res.warnings || [],
				after: summarizeAfter(res.after),
			},
		});
		applyMergedConfig(res.config);
		state.ended = !!res.ended;
		save();
		renderAll();
		scrollTurns();
	} catch (err) {
		toast(`结算失败：${err.message}`, true);
	}
}

async function undoTurn() {
	if (!state.turns.length) return toast('没有可撤销的回合');
	const last = state.turns.pop();
	if (last.before) {
		for (const side of ['p1', 'p2']) {
			state[side].active = last.before[side].active ?? 0;
			last.before[side].slots.forEach((s, i) => {
				if (state[side].slots[i]) restoreSlotFrom(state[side].slots[i], s);
			});
		}
		state.field = last.before.field;
	}
	state.ended = false;
	state.pendingPrngSeed = last.prng || null;
	try {
		await recreateSession();
	} catch (err) {
		toast(`恢复对局失败：${err.message}`, true);
	}
	state.pendingPrngSeed = null;
	save();
	renderAll();
}

/** Clear every turn record and drop the engine session so the next turn starts at 1. */
async function clearBattle() {
	if (!state.turns.length && !state.sessionId) return toast('当前没有回合记录');
	if (!confirm('确定清空所有回合记录？该操作不可撤销。')) return;
	if (state.sessionId) {
		try { await api('closeSession', { sessionId: state.sessionId }); }
		catch { /* session already gone */ }
	}
	state.turns = [];
	state.ended = false;
	state.pendingPrngSeed = null;
	state.sessionId = null;
	state.action = { p1: blankAction(), p2: blankAction() };
	save();
	renderAll();
	toast('已清空所有回合记录，下次结算从第 1 回合开始');
}

async function continueAfterEnd() {
	state.ended = false;
	try {
		await recreateSession();
	} catch (err) {
		toast(`重开沙盘失败：${err.message}`, true);
		return;
	}
	renderAll();
}

function summarizeAfter(after) {
	const lines = [];
	for (const [side, label] of [['p1', 'P1'], ['p2', 'P2']]) {
		const mon = (after[side]?.pokemon || []).find(p => p.slot === after[side].active);
		if (!mon) { lines.push(`${label}：无上场`); continue; }
		const boosts = BOOST_KEYS.filter(k => mon.boosts[k]).map(k => `${STAT_ZH[k]}${mon.boosts[k] > 0 ? '+' : ''}${mon.boosts[k]}`).join(' ');
		const hp = mon.fainted ? '濒死' : `${mon.hp}/${mon.maxhp}`;
		lines.push(`${label} ${mon.species}　HP ${hp}${mon.status ? `　${STATUS_ZH[mon.status] || mon.status}` : ''}${boosts ? `　${boosts}` : ''}`);
	}
	return lines;
}

/* ------------------------------ species pick ------------------------------ */

// Picking a species only sets the species (plus its first ability, which the
// engine needs); everything else stays empty for manual configuration.
function onSpeciesPick(side, slotIndex, sp) {
	const slot = state[side].slots[slotIndex];
	slot.species = sp.name;
	slot.item = '';
	const ab0 = sp.abilities && sp.abilities['0'];
	slot.ability = (ab0 && byName.abilities[ab0]?.name) || '';
	slot.moves = ['', '', '', ''];
	slot.teraType = '';
	slot.hp = null; slot.status = ''; slot.pp = {}; slot.volatiles = [];
	slot.boosts = zero(BOOST_KEYS);
	save();
	renderAll();
}

// Manual "一键配招": fill the slot from the random-battle generator.
async function applyAutoSet(side, slotIndex) {
	const slot = state[side].slots[slotIndex];
	const sp = byName.species[slot.species];
	if (!sp) return toast('先选择物种');
	try {
		const gen = state.format.replace('customgame', 'randombattle').replace('doubles', '');
		const s = await api('suggestSet', { species: sp.id, generatorFormat: gen });
		slot.level = s.level || 100;
		slot.item = s.item || '';
		slot.ability = s.ability || slot.ability;
		slot.nature = s.nature || 'Serious';
		slot.evs = { ...zero(STAT_KEYS), ...s.evs };
		slot.ivs = { ...Object.fromEntries(STAT_KEYS.map(k => [k, 31])), ...s.ivs };
		slot.moves = [...s.moves, '', '', '', ''].slice(0, 4);
		slot.teraType = s.teraType || '';
	} catch {
		toast(`${sp.nameZh || sp.name} 没有自动配置，请手动填写`, true);
	}
	save();
	renderAll();
}

/* ------------------------------ render: side panel ------------------------------ */

function sideHeaderColor(side) { return side === 'p1' ? 'P1（红方）' : 'P2（蓝方）'; }

function renderSide(side) {
	const root = $(side === 'p1' ? '#side-p1' : '#side-p2');
	root.replaceChildren();

	const sideState = state[side];
	const sel = Math.min(state.sel[side], sideState.slots.length - 1);
	state.sel[side] = sel;

	// team tabs
	const tabs = el('div', { class: 'team-tabs' });
	sideState.slots.forEach((slot, i) => {
		const label = slot.species ? `${i + 1} ${speciesShort(slot.species)}` : `${i + 1} 空`;
		const b = el('button', { class: i === sel ? 'cur' : '', onclick: () => { state.sel[side] = i; renderAll(); } }, label);
		tabs.append(b);
	});
	if (sideState.slots.length < 6) {
		tabs.append(el('button', { onclick: () => { sideState.slots.push(blankSlot()); state.sel[side] = sideState.slots.length - 1; renderAll(); } }, '+ 添加'));
	}

	// overview
	const overview = el('div', { class: 'slotlist' });
	sideState.slots.forEach((slot, i) => {
		const stats = calcStats(slot);
		const row = el('div', {
			class: 'slotrow' + (i === sel ? ' cur' : ''),
			onclick: () => { state.sel[side] = i; renderAll(); },
		});
		const hpTxt = slot.hp === null || slot.hp === undefined || !stats
			? (stats ? `满/${stats.hp}` : '—')
			: `${slot.hp}/${stats.hp}`;
		const hpClass = slot.hp !== null && stats
			? (slot.hp <= 0 ? 'zero' : slot.hp / stats.hp <= 0.25 ? 'low' : '') : '';
		row.append(
			el('span', { class: 'nm' }, slot.species
				? `${speciesShort(slot.species)} Lv${slot.level}${speciesTypes(slot.species) ? `〔${speciesTypes(slot.species)}〕` : ''}`
				: '（空槽）'),
			el('span', { class: 'hp ' + hpClass }, hpTxt),
			slot.status ? el('span', { class: 'tag' }, STATUS_ZH[slot.status] || slot.status) : null,
			i === sideState.active ? el('span', { class: 'act' }, '●上场') : null,
		);
		overview.append(row);
	});

	root.append(
		el('h2', null, sideHeaderColor(side)),
		tabs,
		overview,
		renderSlotEditor(side, sel),
		renderActionBox(side),
	);
}

function speciesShort(name) {
	return byName.species[name]?.nameZh || name;
}
function speciesTypes(name) {
	const types = byName.species[name]?.types;
	return types ? types.map(t => TYPE_ZH[t] || t).join('/') : '';
}

function abilityOptions(slot) {
	const sp = byName.species[slot.species];
	const out = [['', '（无）']];
	if (!sp) return out;
	for (const key of ['0', '1', 'H', 'S']) {
		const ab = sp.abilities?.[key];
		if (!ab) continue;
		const entry = byName.abilities[ab] || (CATALOG.abilities.find(a => a.id === ab));
		if (entry) out.push([entry.name, `${entry.nameZh || entry.name}${key === 'H' ? '（隐藏）' : ''}`]);
	}
	return out;
}

const VOLATILE_LIMIT = 48;

function volatileEditor(slot, enabled) {
	const wrap = el('div', { class: 'vols' });
	const search = el('input', {
		type: 'text', class: 'volsearch',
		placeholder: enabled ? '搜索附加状态（中文/英文），留空显示常用…' : '仅上场宝可梦可设置',
	});
	search.disabled = !enabled;
	const chips = el('div', { class: 'chips' });
	const selected = () => slot.volatiles || [];

	const draw = () => {
		chips.textContent = '';
		const chosen = new Set(selected());
		const q = search.value.trim();
		const lower = q.toLowerCase();
		let list;
		if (q) {
			list = (CATALOG?.volatiles || []).filter(v =>
				v.id.includes(lower) || v.name.toLowerCase().includes(lower) || (v.nameZh || '').includes(q)
			).slice(0, VOLATILE_LIMIT);
		} else {
			const common = (CATALOG?.commonVolatiles || []).filter(id => byVolatile.has(id));
			const extra = [...chosen].filter(id => !common.includes(id));
			list = [...common, ...extra].map(id => byVolatile.get(id)).filter(Boolean);
		}
		for (const v of list) {
			const on = chosen.has(v.id);
			const chip = el('button', {
				type: 'button',
				class: `chip${on ? ' on' : ''}`,
				title: `${v.name}（${v.id}）`,
				onclick: () => {
					slot.volatiles = on
						? selected().filter(x => x !== v.id)
						: [...selected(), v.id];
					draw();
				},
			}, v.nameZh || v.name);
			if (!enabled) chip.disabled = true;
			chips.append(chip);
		}
		if (!list.length) chips.append(el('span', { class: 'hint' }, '没有匹配的附加状态'));
	};

	search.addEventListener('input', draw);
	draw();
	wrap.append(search, chips);
	return wrap;
}

/* ------------------------------ stat group editor ------------------------------ */

// A labelled 6/7-column numeric grid: one caption per stat above its input, so
// every EV / IV / boost value can be told apart at a glance.
function statGroup({ title, hint, keys, values, def, min, max, onChange }) {
	const wrap = el('div', { class: 'statgrp' });
	wrap.append(el('div', { class: 'grphead' },
		el('span', null, title),
		hint ? el('span', { class: 'hint' }, hint) : null,
	));
	const grid = el('div', { class: 'statgrid' + (keys.length > 6 ? ' wide' : '') });
	for (const k of keys) {
		const value = values[k] === undefined || values[k] === null ? def : values[k];
		grid.append(el('label', { class: 'cell', title: `${STAT_ZH[k] || k}（${k}）` },
			el('span', { class: 'cap' }, STAT_ZH[k] || k),
			numInput(value, { min, max }, v => onChange(k, v)),
		));
	}
	wrap.append(grid);
	return wrap;
}

function renderSlotEditor(side, i) {
	const slot = state[side].slots[i];
	if (!slot) return el('div', { class: 'hint' }, '没有槽位');
	const stats = calcStats(slot);

	const fsIdentity = el('fieldset', { class: 'fieldset' });
	fsIdentity.append(el('legend', null, '身份'));
	const grid = el('div', { class: 'grid2' });
	grid.append(
		el('label', null, '物种'),
		combo({
			value: speciesDisplay(slot.species), placeholder: '搜索物种（中文/英文）…',
			getItems: filter => {
				if (!filter) return [];
				return CATALOG.species.filter(s =>
					s.name.toLowerCase().includes(filter) || (s.nameZh || '').includes(filter) || s.id.includes(filter)
				).slice(0, 60);
			},
			render: speciesLabel,
			onPick: sp => onSpeciesPick(side, i, sp),
		}),
		el('label', null, '等级'),
		numInput(slot.level, { min: 1, max: 100 }, v => { slot.level = v || 100; refreshStats(side, i); }),
		el('label', null, '性别'),
		select([['', '随机'], ['M', '♂'], ['F', '♀']], slot.gender, v => { slot.gender = v; }),
		el('label', null, '太晶属性'),
		select([['', '不使用'], ...TYPES.map(t => [t, TYPE_ZH[t]])], slot.teraType, v => { slot.teraType = v; }),
	);
	fsIdentity.append(grid);
	fsIdentity.append(el('div', { style: 'margin-top:6px' },
		el('button', { onclick: () => applyAutoSet(side, i) }, '一键配招'),
		' ',
		el('button', {
			onclick: () => {
				if (state[side].slots.length <= 1) return toast('至少保留一个槽位');
				state[side].slots.splice(i, 1);
				state.sel[side] = Math.max(0, i - 1);
				state[side].active = Math.min(state[side].active, state[side].slots.length - 1);
				renderAll();
			},
		}, '移除'),
		' ',
		state[side].active === i
			? el('span', { class: 'tag ok' }, '当前上场')
			: el('button', { onclick: () => { state[side].active = i; renderAll(); } }, '设为上场'),
	));

	// stats: nature + ev/iv
	const fsStats = el('fieldset', { class: 'fieldset' });
	fsStats.append(el('legend', null, '数值'));
	const natureSel = select(
		(CATALOG ? CATALOG.natures : []).map(n => [n.name, `${NATURE_ZH[n.name] || n.name}${n.plus ? `（+${STAT_ZH[n.plus]} −${STAT_ZH[n.minus]}）` : ''}`]),
		slot.nature, v => { slot.nature = v; refreshStats(side, i); }
	);
	fsStats.append(el('div', { class: 'grid2' }, el('label', null, '性格'), natureSel));

	const show = state.show[side];
	if (show.evs) {
		fsStats.append(statGroup({
			title: '努力值 EV', hint: '0–252', keys: STAT_KEYS, values: slot.evs, def: 0, min: 0, max: 252,
			onChange: (k, v) => {
				slot.evs[k] = v || 0;
				const total = STAT_KEYS.reduce((s, key) => s + (slot.evs[key] || 0), 0);
				if (total > 510) toast(`努力值总和 ${total} 超过 510（自定义对战不强制）`);
				refreshStats(side, i);
			},
		}));
	}
	if (show.ivs) {
		fsStats.append(statGroup({
			title: '个体值 IV', hint: '0–31', keys: STAT_KEYS, values: slot.ivs, def: 31, min: 0, max: 31,
			onChange: (k, v) => { slot.ivs[k] = v === null ? 31 : v; refreshStats(side, i); },
		}));
	}
	const statsDiv = el('div', { class: 'statsline', id: `stats-${side}-${i}` });
	if (show.stats) fsStats.append(statsDiv);

	// config: item / ability / moves
	const fsConfig = el('fieldset', { class: 'fieldset' });
	fsConfig.append(el('legend', null, '配置'));
	const cfgGrid = el('div', { class: 'grid2' });
	cfgGrid.append(
		el('label', null, '道具'),
		combo({
			value: itemDisplay(slot.item), placeholder: '搜索道具…',
			getItems: filter => {
				if (!filter) return [];
				return CATALOG.items.filter(it =>
					it.name.toLowerCase().includes(filter) || (it.nameZh || '').includes(filter)
				).slice(0, 60);
			},
			render: itemLabel,
			onPick: it => { slot.item = it.name; renderAll(); },
		}),
		el('label', null, '特性'),
		select(abilityOptions(slot), slot.ability, v => { slot.ability = v; }),
	);
	fsConfig.append(cfgGrid);
	const movesWrap = el('div', { class: 'moves', style: 'margin-top:4px' });
	slot.moves.forEach((mv, mi) => {
		movesWrap.append(el('div', { class: 'grid2' },
			el('label', null, `招式 ${mi + 1}`),
			combo({
				value: moveDisplay(mv), placeholder: '搜索招式…',
				getItems: filter => {
					if (!filter) return [];
					return CATALOG.moves.filter(m =>
						m.name.toLowerCase().includes(filter) || (m.nameZh || '').includes(filter) || m.id.includes(filter)
					).slice(0, 60);
				},
				render: moveLabel,
				onPick: m => { slot.moves[mi] = m.name; renderAll(); },
			}),
		));
	});
	fsConfig.append(movesWrap);

	// current state
	const fsState = el('fieldset', { class: 'fieldset' });
	fsState.append(el('legend', null, '当前状态'));
	const stateGrid = el('div', { class: 'grid2' });
	stateGrid.append(
		el('label', null, '当前 HP'),
		el('span', null,
			numInput(slot.hp, { min: 1, max: stats ? stats.hp : 999 }, v => { slot.hp = v; }),
			` / ${stats ? stats.hp : '?'}`,
			el('span', { class: 'hint' }, '（留空＝保持）'),
		),
		el('label', null, '异常状态'),
		select(STATUS_OPTS, slot.status, v => { slot.status = v; }),
	);
	fsState.append(stateGrid);
	if (show.boosts) {
		fsState.append(statGroup({
			title: '能力变化', hint: '−6 ~ +6', keys: BOOST_KEYS, values: slot.boosts, def: 0, min: -6, max: 6,
			onChange: (k, v) => { slot.boosts[k] = v || 0; },
		}));
	}

	// Volatile statuses come from the engine catalog (106+ entries), so the
	// editor shows a short common list and switches to search over everything.
	const onActive = state[side].active === i;
	const volBox = volatileEditor(slot, onActive);
	fsState.append(
		el('div', { class: 'volhead' },
			'附加状态',
			onActive ? null : el('span', { class: 'hint' }, '（仅上场宝可梦可设置）'),
		),
		volBox,
		el('div', { class: 'hint' }, '能力等级与附加状态只作用于当前上场的宝可梦；改动会在下一次结算时重建沙盘并从当前局面继续。'),
	);

	const statsText = () => {
		const s = calcStats(slot);
		return s ? `六维：HP ${s.hp} / 攻 ${s.atk} / 防 ${s.def} / 特攻 ${s.spa} / 特防 ${s.spd} / 速 ${s.spe}` : '六维：先选择物种';
	};
	statsDiv.textContent = statsText();
	function refreshStats(side, i) {
		const node = document.getElementById(`stats-${side}-${i}`);
		if (node) node.textContent = statsText();
	}

	return el('div', null, fsIdentity, fsStats, fsConfig, fsState);
}

function renderActionBox(side) {
	const box = el('div', { class: 'actionbox' });
	box.append(el('h3', null, `本回合动作（${side.toUpperCase()}）`));
	const a = state.action[side];
	const slot = state[side].slots[state[side].active];
	if (!slot || !slot.species) {
		box.append(el('div', { class: 'hint' }, '先在该槽位选择物种'));
		return box;
	}
	const moves = slot.moves.filter(Boolean);
	if (!moves.length) {
		box.append(el('div', { class: 'hint' }, '该宝可梦没有配置招式'));
	}
	moves.forEach((mv, mi) => {
		const entry = byName.moves[mv];
		const moveId = entry?.id;
		const pp = moveId && slot.pp[moveId] !== undefined ? slot.pp[moveId] : null;
		const maxpp = entry?.pp ?? '—';
		const opt = el('label', { class: 'opt' },
			el('input', {
				type: 'radio', name: `act-${side}`,
				checked: a.switchSlot === null && a.index === mi,
				onclick: () => { a.kind = 'move'; a.index = mi; a.switchSlot = null; renderActionOnly(side); },
			}),
			`${entry?.nameZh || mv}（${entry ? (TYPE_ZH[entry.type] || entry.type) + (entry.power ? ` ${entry.power}` : ' 变化') : ''}）`,
			el('span', { class: 'pp' }, pp === null ? `PP ${maxpp}` : `PP ${pp}/${maxpp}`),
		);
		box.append(opt);
	});
	if (slot.teraType) {
		box.append(check(a.tera, on => { a.tera = on; }, `太晶化（${TYPE_ZH[slot.teraType] || slot.teraType}）`));
		box.append(' ');
	}
	// switch options
	const bench = state[side].slots
		.map((s, idx) => ({ s, idx }))
		.filter(({ s, idx }) => idx !== state[side].active && s.species);
	if (bench.length) {
		const sel = el('select', { onchange: e => {
			const v = e.target.value;
			a.switchSlot = v === '' ? null : Number(v);
			renderActionOnly(side);
		} });
		sel.append(el('option', { value: '' }, '（不换人）'));
		for (const { s, idx } of bench) {
			sel.append(el('option', { value: String(idx) }, `换 ${idx + 1} ${speciesShort(s.species)}`));
		}
		sel.value = a.switchSlot === null ? '' : String(a.switchSlot);
		box.append(el('div', { style: 'margin-top:4px' }, sel));
	}
	return box;
}

function renderActionOnly(side) {
	const root = $(side === 'p1' ? '#side-p1' : '#side-p2');
	const old = root.querySelector('.actionbox');
	if (old) old.replaceWith(renderActionBox(side));
}

/* ------------------------------ render: mid ------------------------------ */

function scrollTurns() {
	const t = $('#turns');
	if (t) t.scrollTop = t.scrollHeight;
}

function renderMid() {
	const root = $('#mid');
	root.replaceChildren();

	// toolbar
	const bar = el('div', { class: 'bar' });
	bar.append(
		el('label', { class: 'muted' }, '种子 '),
		...state.seed.map((v, i) => el('input', {
			type: 'number', value: v, style: 'width:70px',
			onchange: e => { state.seed[i] = Number(e.target.value) || 0; },
		})),
		el('button', { onclick: () => { state.seed = randSeed(); renderMid(); toast('种子已重掷（下次重开沙盘时生效）'); } }, '重掷'),
		el('span', { class: 'grow' }),
		el('button', { onclick: undoTurn }, '撤销上回合'),
		el('button', { class: 'danger', onclick: clearBattle }, '清空对战'),
		el('button', { class: 'primary', onclick: resolveTurn }, '▶ 结算本回合'),
	);

	// field
	const fs = el('fieldset', { class: 'fieldset' });
	fs.append(el('legend', null, '场地'));
	const grid = el('div', { class: 'grid2' });
	grid.append(
		el('label', null, '天气'),
		select(WEATHER_OPTS, state.field.weather, v => { state.field.weather = v; }),
		el('label', null, '场地'),
		select(TERRAIN_OPTS, state.field.terrain, v => { state.field.terrain = v; }),
	);
	fs.append(grid);
	for (const side of ['p1', 'p2']) {
		const row = el('div', { style: 'margin-top:4px' }, el('span', { class: 'muted' }, `${side.toUpperCase()}：`));
		for (const [id, zh] of SIDE_COND_OPTS) {
			row.append(check(state.field[side].conditions.includes(id), on => {
				const list = state.field[side].conditions;
				state.field[side].conditions = on ? [...list, id] : list.filter(c => c !== id);
			}, zh));
			row.append(' ');
		}
		fs.append(row);
	}

	// banner
	if (state.ended) {
		root.append(el('div', { id: 'banner' },
			'对局已结束（一方全灭或平局）。沙盘模式下可以调整参数后继续。',
			el('button', { onclick: continueAfterEnd }, '重开沙盘继续'),
		));
	}

	// turns
	const turns = el('div', { id: 'turns' });
	if (!state.turns.length) {
		turns.append(el('div', { class: 'hint' },
			'还没有回合记录。在左右面板配置双方宝可梦与本回合动作，然后点「结算本回合」。'));
	}
	for (const t of state.turns) turns.append(renderTurnCard(t));

	root.append(bar, fs, turns);
}

function renderTurnCard(t) {
	const card = el('div', { class: 'turncard' });
	const head = el('div', { class: 'head' });
	head.append(el('span', { class: 'n' }, `第 ${t.turn} 回合`));
	if (t.meta.rebuilt) head.append(el('span', { class: 'tag info' }, '重开沙盘'));
	if (t.meta.ended) head.append(el('span', { class: 'tag ok' }, '对局结束'));
	head.append(el('button', {
		class: 'copy', onclick: () => {
			navigator.clipboard.writeText(cardText(t)).then(() => toast('已复制本回合文本'));
		},
	}, '复制'));
	card.append(head);

	const inLines = [];
	if (t.before) {
		for (const [side, label] of [['p1', 'P1'], ['p2', 'P2']]) {
			const c = t.choices[side] || { kind: 'move', index: 0 };
			const slot = t.before[side].slots[t.before[side].active];
			const name = slot?.species ? speciesShort(slot.species) : '？';
			let act;
			if (c.kind === 'switch') {
				const to = t.before[side].slots[c.slot];
				act = `换上 ${to?.species ? speciesShort(to.species) : '？'}`;
			} else {
				const mv = slot?.moves[c.index];
				act = `${mv ? (byName.moves[mv]?.nameZh || mv) : '？'}${c.tera ? '（太晶）' : ''}`;
			}
			inLines.push(`${label} ${name} → ${act}`);
		}
		const f = t.before.field;
		const env = [WEATHER_OPTS.find(w => w[0] === f.weather)?.[1], TERRAIN_OPTS.find(w => w[0] === f.terrain)?.[1]].filter(Boolean).join(' · ');
		if (env) inLines.push(`环境：${env}`);
	}
	card.append(el('div', { class: 'in' }, inLines.join('\n')));
	card.append(el('div', { class: 'txt' }, (t.text || []).join('\n') || '（无事件）'));
	if (t.meta.warnings?.length) {
		card.append(el('div', { class: 'warn' }, t.meta.warnings.join('\n')));
	}
	if (t.meta.after?.length) {
		card.append(el('div', { class: 'after' }, '回合后\n' + t.meta.after.join('\n')));
	}
	return card;
}

function cardText(t) {
	const parts = [`第 ${t.turn} 回合`];
	if (t.before) {
	for (const [side, label] of [['p1', 'P1'], ['p2', 'P2']]) {
		const c = t.choices[side] || { kind: 'move', index: 0 };
		const slot = t.before[side].slots[t.before[side].active];
		const name = slot?.species ? speciesShort(slot.species) : '？';
		const mv = c.kind === 'move' ? slot?.moves[c.index] : null;
			parts.push(`${label} ${name} → ${c.kind === 'switch' ? '换人' : (mv ? (byName.moves[mv]?.nameZh || mv) : '？')}${c.tera ? '（太晶）' : ''}`);
		}
	}
	parts.push('', ...(t.text || []));
	if (t.meta.after?.length) parts.push('', '回合后', ...t.meta.after);
	return parts.join('\n');
}

/* ------------------------------ settings sheet ------------------------------ */

let settingsTab = 'ui';
let engineInfo = null;
let engineBusy = false;

function engineProgress(data) {
	const box = $('#engine-progress');
	if (!box) return;
	box.hidden = false;
	const bar = $('#engine-progress-bar');
	if (bar) bar.style.width = (data.percent === null || data.percent === undefined)
		? '35%' : `${Math.max(0, Math.min(100, data.percent))}%`;
	const txt = $('#engine-progress-text');
	if (txt) txt.textContent = data.text || data.stage || '';
}

function setEngineBusy(on, text) {
	engineBusy = !!on;
	for (const id of ['#btn-engine-move', '#btn-engine-update']) {
		const btn = $(id);
		if (btn) btn.disabled = !!on;
	}
	if (text) $('#engine-update-status').textContent = text;
	if (!on) {
		const box = $('#engine-progress');
		if (box) box.hidden = true;
		const bar = $('#engine-progress-bar');
		if (bar) bar.style.width = '0';
	}
}

async function loadEngineInfo() {
	try {
		engineInfo = await appApi('getEngineInfo');
	} catch (err) {
		engineInfo = null;
		const path = $('#engine-path');
		if (path) path.value = '仅桌面应用可用';
		$('#engine-meta').textContent = err.message;
		$('#engine-update-status').textContent = err.message;
		for (const id of ['#btn-engine-move', '#btn-engine-update']) {
			const btn = $(id);
			if (btn) btn.disabled = true;
		}
		return;
	}
	$('#engine-path').value = engineInfo.engineDir;
	const meta = engineInfo.meta;
	const base = meta
		? `引擎 ${meta.version || engineInfo.version || '?'} · 同步于 ${meta.syncedAt ? meta.syncedAt.slice(0, 10) : '—'} · 提交 ${String(meta.sha || '').slice(0, 7)}`
		: `引擎 ${engineInfo.version || '?'} · 尚未记录同步版本（首次更新会建立基准）`;
	$('#engine-meta').textContent = base + (engineInfo.writable ? '' : ' · 目录只读，更新可能需要管理员权限');
	$('#engine-update-status').textContent = '尚未检查更新';
	if (!engineBusy) {
		for (const id of ['#btn-engine-move', '#btn-engine-update']) {
			const btn = $(id);
			if (btn) btn.disabled = false;
		}
	}
}

/** Reload catalog + drop the stale session after the host process restarts. */
async function afterEngineChange(message) {
	state.sessionId = null;
	try {
		PROBE = await api('probe');
		CATALOG = await api('catalog');
		byName = {
			species: Object.fromEntries(CATALOG.species.map(s => [s.name, s])),
			moves: Object.fromEntries(CATALOG.moves.map(m => [m.name, m])),
			items: Object.fromEntries(CATALOG.items.map(i => [i.name, i])),
			abilities: Object.fromEntries(CATALOG.abilities.map(a => [a.name, a])),
		};
		byVolatile = new Map((CATALOG.volatiles || []).map(v => [v.id, v]));
		const fmt = $('#format');
		fmt.replaceChildren();
		for (const f of PROBE.formats.filter(f => f.supported)) fmt.append(el('option', { value: f.id }, f.label));
		if (!Array.from(fmt.options).some(o => o.value === state.format)) {
			state.format = fmt.options[0]?.value || 'gen9customgame';
		}
	} catch (err) {
		$('#engine-update-status').textContent = `${message}；目录重新载入失败：${err.message}（可重启应用）`;
	}
	save();
	renderAll();
	await loadEngineInfo();
	if (message) $('#engine-update-status').textContent = message;
}

async function chooseEngineLocation() {
	if (engineBusy) return;
	try {
		const dir = await appApi('chooseEngineDir');
		if (!dir) return; // user cancelled the folder picker
		const target = `${dir.replace(/[\\/]+$/, '')}\\engine`;
		if (!confirm(`确定把引擎与数据移动到：\n${target}\n\n移动后程序会改为从新位置读取，原位置文件将被清理。`)) return;
		setEngineBusy(true, '正在移动引擎与数据…');
		engineProgress({ stage: 'move', text: '正在移动引擎与数据…', percent: null });
		const res = await appApi('moveEngine', { dir });
		await afterEngineChange(res.message || '引擎位置已更新');
		toast(res.message || '引擎位置已更新');
		if (res.warning) toast(res.warning, true);
		if (res.hostRestart && !res.hostRestart.ok) {
			toast(`引擎已移动，但重新加载失败：${res.hostRestart.error}（可重启应用）`, true);
		}
	} catch (err) {
		$('#engine-update-status').textContent = `移动失败：${err.message}`;
		toast(`移动失败：${err.message}`, true);
	} finally {
		setEngineBusy(false);
	}
}

async function updateEngineData() {
	if (engineBusy) return;
	setEngineBusy(true, '正在检查更新…');
	engineProgress({ stage: 'check', text: '正在检查更新…', percent: null });
	try {
		const res = await appApi('updateEngine');
		if (!res.updated) {
			await loadEngineInfo();
			$('#engine-update-status').textContent = '已是最新版本';
			toast('已是最新版本');
			return;
		}
		await afterEngineChange(res.message);
		toast(res.message);
		if (res.hostRestart && !res.hostRestart.ok) {
			toast(`引擎已更新，但重新加载失败：${res.hostRestart.error}（可重启应用）`, true);
		}
	} catch (err) {
		$('#engine-update-status').textContent = `更新失败：${err.message}`;
		toast(`更新失败：${err.message}`, true);
	} finally {
		setEngineBusy(false);
	}
}

function switchSettingsTab(tab) {
	settingsTab = tab === 'data' ? 'data' : 'ui';
	$('#settings-ui').hidden = settingsTab !== 'ui';
	$('#settings-data').hidden = settingsTab !== 'data';
	$('#tab-ui').classList.toggle('cur', settingsTab === 'ui');
	$('#tab-data').classList.toggle('cur', settingsTab === 'data');
	if (settingsTab === 'data') loadEngineInfo();
}

// Settings sheet: per-side on/off switches for the EV / IV / boost editors.
function renderSettings() {
	const body = $('#settings-body');
	body.replaceChildren();

	const grid = el('div', { class: 'setgrid' });
	grid.append(
		el('span'),
		el('div', { class: 'seth p1' }, '红方 P1'),
		el('div', { class: 'seth p2' }, '蓝方 P2'),
	);
	for (const [key, label] of SHOW_FIELDS) {
		grid.append(el('div', { class: 'setlbl' }, label));
		for (const side of ['p1', 'p2']) {
			grid.append(el('div', { class: 'setcell' },
				check(state.show[side][key], on => {
					state.show[side][key] = on;
					save();
					renderSide(side);
				}),
			));
		}
	}

	const bulk = el('div', { class: 'setbulk' });
	for (const [side, label] of [['p1', '红方'], ['p2', '蓝方']]) {
		bulk.append(
			el('span', { class: 'muted' }, label),
			el('button', { onclick: () => setAllShow(side, true) }, '全部显示'),
			el('button', { onclick: () => setAllShow(side, false) }, '全部隐藏'),
		);
	}

	body.append(grid, bulk);
}

function setAllShow(side, on) {
	for (const [key] of SHOW_FIELDS) state.show[side][key] = on;
	save();
	renderSettings();
	renderSide(side);
}

function openSettings(tab) {
	renderSettings();
	switchSettingsTab(tab || 'ui');
	$('#settings').hidden = false;
}
function closeSettings() {
	$('#settings').hidden = true;
}

/* ------------------------------ render all / topbar ------------------------------ */

function renderAll() {
	renderTop();
	renderSide('p1');
	renderSide('p2');
	renderMid();
}

function renderTop() {
	const fmt = $('#format');
	if (!fmt.options.length && PROBE) {
		for (const f of PROBE.formats.filter(f => f.supported)) {
			fmt.append(el('option', { value: f.id }, f.label));
		}
	}
	fmt.value = state.format;
	fmt.onchange = () => { state.format = fmt.value; save(); renderAll(); };
	$('#engine-info').textContent = PROBE
		? `引擎 ${PROBE.engineVersion} · 物种 ${PROBE.speciesCount} · 招式 ${PROBE.moveCount}` : '';
	$('#session-info').textContent =
		`回合 ${state.turns.length}${state.sessionId ? ' · 会话中' : ''}${state.ended ? ' · 已结束' : ''}`;
}

/* ------------------------------ save / load ------------------------------ */

function save() {
	try {
		localStorage.setItem('pbsim-doc', JSON.stringify(exportDoc()));
	} catch { /* quota */ }
}

function exportDoc() {
	return {
		schema: 1,
		app: 'PokemonBattleSim',
		format: state.format,
		seed: [...state.seed],
		show: clone(state.show),
		field: clone(state.field),
		p1: { active: state.p1.active, slots: state.p1.slots.map(s => ({ ...s })) },
		p2: { active: state.p2.active, slots: state.p2.slots.map(s => ({ ...s })) },
		turns: state.turns.map(t => ({
			turn: t.turn, choices: t.choices, text: t.text || [],
			meta: { rebuilt: t.meta?.rebuilt, ended: t.meta?.ended, warnings: t.meta?.warnings, after: t.meta?.after },
		})),
	};
}

function importDoc(doc) {
	state = blankState();
	state.format = doc.format || 'gen9customgame';
	state.seed = doc.seed || randSeed();
	for (const side of ['p1', 'p2']) {
		state.show[side] = { ...blankShow(), ...(doc.show?.[side] || {}) };
	}
	if (doc.field) state.field = clone(doc.field);
	for (const side of ['p1', 'p2']) {
		if (!doc[side]?.slots?.length) continue;
		state[side].active = doc[side].active || 0;
		state[side].slots = doc[side].slots.map(s => ({ ...blankSlot(), ...s }));
	}
	state.turns = (doc.turns || []).map(t => ({
		turn: t.turn, choices: t.choices || {}, before: null,
		text: t.text || [], meta: t.meta || {},
	}));
	state.sessionId = null;
	state.ended = false;
	save();
	renderAll();
	toast(`已导入：${state.turns.length} 个回合记录（撤销仅对本次会话新结算的回合可用）`);
}

/* ------------------------------ boot ------------------------------ */

// Small hook for automated UI smoke tests (no effect on normal use).
window.__app = {
	getState: () => state,
	getCatalog: () => CATALOG,
	pick: onSpeciesPick,
	autoSet: applyAutoSet,
	resolve: resolveTurn,
	renderAll,
	clearBattle,
	openSettings,
	switchSettingsTab,
	updateEngineData,
	chooseEngineLocation,
	getEngineInfo: () => engineInfo,
};

async function boot() {
	state = blankState();
	try {
		const saved = localStorage.getItem('pbsim-doc');
		if (saved) importDoc(JSON.parse(saved));
	} catch { /* ignore bad save */ }

	PROBE = await api('probe');
	CATALOG = await api('catalog');
	byName = {
		species: Object.fromEntries(CATALOG.species.map(s => [s.name, s])),
		moves: Object.fromEntries(CATALOG.moves.map(m => [m.name, m])),
		items: Object.fromEntries(CATALOG.items.map(i => [i.name, i])),
		abilities: Object.fromEntries(CATALOG.abilities.map(a => [a.name, a])),
	};
	byVolatile = new Map((CATALOG.volatiles || []).map(v => [v.id, v]));

	$('#btn-settings').onclick = () => openSettings('ui');
	$('#tab-ui').onclick = () => switchSettingsTab('ui');
	$('#tab-data').onclick = () => switchSettingsTab('data');
	$('#btn-engine-move').onclick = chooseEngineLocation;
	$('#btn-engine-update').onclick = updateEngineData;
	if (window.pbsim?.onEngineProgress) window.pbsim.onEngineProgress(engineProgress);
	$('#settings-close').onclick = closeSettings;
	$('#settings').addEventListener('mousedown', e => { if (e.target.id === 'settings') closeSettings(); });
	document.addEventListener('keydown', e => {
		if (e.key === 'Escape' && !$('#settings').hidden) closeSettings();
	});

	$('#btn-new').onclick = () => {
		if (!confirm('新建对局将清空当前配置与回合记录？')) return;
		(async () => {
			if (state.sessionId) { try { await api('closeSession', { sessionId: state.sessionId }); } catch {} }
			state = blankState();
			save();
			renderAll();
		})();
	};
	$('#btn-export').onclick = () => {
		const blob = new Blob([JSON.stringify(exportDoc(), null, 2)], { type: 'application/json' });
		const a = el('a', { href: URL.createObjectURL(blob), download: `battle-${new Date().toISOString().slice(0, 10)}.json` });
		a.click();
		URL.revokeObjectURL(a.href);
	};
	$('#file-import').onchange = e => {
		const file = e.target.files[0];
		if (!file) return;
		const reader = new FileReader();
		reader.onload = () => {
			try {
				importDoc(JSON.parse(reader.result));
			} catch (err) {
				toast(`导入失败：${err.message}`, true);
			}
			e.target.value = '';
		};
		reader.readAsText(file);
	};

	renderAll();
}

boot().catch(err => toast(`初始化失败：${err.message}`, true));
