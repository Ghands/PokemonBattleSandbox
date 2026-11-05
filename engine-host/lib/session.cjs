'use strict';

const path = require('path');

const engineCache = new Map();
function loadEngine(engineDir) {
	const entry = path.join(engineDir, 'dist', 'sim', 'index.js');
	if (!engineCache.has(entry)) engineCache.set(entry, require(entry));
	return engineCache.get(entry);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clone = value => JSON.parse(JSON.stringify(value));

class Inbox {
	constructor(stream) {
		this.lines = [];
		this.cursor = 0;
		this.ended = false;
		this.error = null;
		this._pump(stream);
	}

	async _pump(stream) {
		try {
			for await (const chunk of stream) {
				for (const line of String(chunk).split('\n')) {
					if (line) this.lines.push(line);
				}
			}
		} catch (err) {
			this.error = err;
		} finally {
			this.ended = true;
		}
	}

	async next(predicate, timeoutMs = 15000) {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			while (this.cursor < this.lines.length) {
				const line = this.lines[this.cursor++];
				if (predicate(line)) return line;
			}
			if (this.error) throw this.error;
			if (this.ended) return null;
			if (Date.now() > deadline) throw new Error('Timed out waiting for battle output');
			await sleep(2);
		}
	}

	errors() {
		return this.lines.filter(line => line.startsWith('|error|'));
	}
}

const isRequest = line => line.startsWith('|request|');
const parseRequest = line => JSON.parse(line.slice('|request|'.length));

function normalizeSet(set) {
	return {
		name: set.name || set.species,
		species: set.species,
		item: set.item || '',
		ability: set.ability || '',
		nature: set.nature || 'Serious',
		level: set.level || 100,
		gender: set.gender || '',
		evs: { hp: 0, atk: 0, def: 0, spa: 0, spd: 0, spe: 0, ...(set.evs || {}) },
		ivs: { hp: 31, atk: 31, def: 31, spa: 31, spd: 31, spe: 31, ...(set.ivs || {}) },
		moves: (set.moves || []).filter(Boolean).slice(0, 4),
		teraType: set.teraType || '',
	};
}

function structuralKey(config) {
	return JSON.stringify({
		format: config.format || 'gen9customgame',
		p1: { sets: (config.p1.slots || []).map(normalizeSet) },
		p2: { sets: (config.p2.slots || []).map(normalizeSet) },
	});
}

function normalizeField(field = {}) {
	return {
		weather: field.weather || '',
		terrain: field.terrain || '',
		p1: { conditions: [...(field.p1?.conditions || [])].sort() },
		p2: { conditions: [...(field.p2?.conditions || [])].sort() },
	};
}

function choiceToString(choice, switchPos) {
	if (!choice) return 'pass';
	if (choice.kind === 'move') return `move ${choice.index + 1}${choice.tera ? ' terastallize' : ''}`;
	if (choice.kind === 'switch') {
		const pos = switchPos(choice.slot);
		if (!pos) throw new Error(`switch target slot ${choice.slot} is not in the team`);
		return `switch ${pos}`;
	}
	return 'pass';
}
class BattleSession {
	constructor({ engineDir, format = 'gen9customgame', seed = [1, 2, 3, 4] }) {
		this.engineDir = engineDir;
		this.format = format;
		this.seed = seed;
		this.Sim = loadEngine(engineDir);
		this.battle = null;
		this.stream = null;
		this.streams = null;
		this.inbox = null;
		this.orders = null;
		this.structural = null;
		this.snapshot = null;
		this.turn = 0;
		this.requests = null;
		this.ended = false;
		this.warnings = [];
		this.barrierId = 0;
		this.lastPrng = null;
	}

	async start(config) {
		this.format = config.format || this.format;
		this.seed = config.seed || this.seed;
		this.stream = new this.Sim.BattleStream();
		this.streams = this.Sim.getPlayerStreams(this.stream);
		this.inbox = {
			omniscient: new Inbox(this.streams.omniscient),
			p1: new Inbox(this.streams.p1),
			p2: new Inbox(this.streams.p2),
		};

		const slots1 = (config.p1.slots || []).map(normalizeSet);
		const slots2 = (config.p2.slots || []).map(normalizeSet);
		if (!slots1.length || !slots2.length) throw new Error('each side needs at least one Pokemon');

		this.orders = {
			p1: this._order(slots1, config.p1.active || 0),
			p2: this._order(slots2, config.p2.active || 0),
		};
		const packed1 = this.Sim.Teams.pack(this.orders.p1.map(i => slots1[i]));
		const packed2 = this.Sim.Teams.pack(this.orders.p2.map(i => slots2[i]));

		this.streams.omniscient.write(`>start ${JSON.stringify({ formatid: this.format, seed: this.seed })}`);
		this.streams.omniscient.write(`>player p1 ${JSON.stringify({ name: 'P1', team: packed1 })}`);
		this.streams.omniscient.write(`>player p2 ${JSON.stringify({ name: 'P2', team: packed2 })}`);

		let req1 = parseRequest(await this.inbox.p1.next(isRequest));
		let req2 = parseRequest(await this.inbox.p2.next(isRequest));

		if (req1.teamPreview || req2.teamPreview) {
			if (req1.teamPreview) this.streams.p1.write('team 1');
			if (req2.teamPreview) this.streams.p2.write('team 1');
			if (req1.teamPreview) req1 = parseRequest(await this.inbox.p1.next(isRequest));
			if (req2.teamPreview) req2 = parseRequest(await this.inbox.p2.next(isRequest));
		}

		this.battle = this.stream.battle;
		if (!this.battle || !this.battle.sides[1]) throw new Error('battle failed to start (invalid team?)');

		// PS swaps side.pokemon entries when switching, so remember the stable
		// Pokemon object -> original team slot mapping.
		this.slotMaps = { p1: new Map(), p2: new Map() };
		this.monBySlot = { p1: new Map(), p2: new Map() };
		for (const [sideIndex, key] of [[0, 'p1'], [1, 'p2']]) {
			const side = this.battle.sides[sideIndex];
			this.orders[key].forEach((slotIndex, pos) => {
				const mon = side.pokemon[pos];
				if (!mon) return;
				this.slotMaps[key].set(mon, slotIndex);
				this.monBySlot[key].set(slotIndex, mon);
			});
		}

		this.ended = false;
		this.structural = structuralKey(config);
		this._injectAll(config);
		await this._barrier();
		this._ensureVolatiles(config);
		if (config.prngSeed) {
			// Deterministic restore (undo): replay from an exact PRNG state.
			this.streams.omniscient.write(`>editbattle reseed ${config.prngSeed}`);
			await this._barrier();
		}
		this.requests = { p1: req1, p2: req2 };
		this.snapshot = this.readState();
		return this;
	}

	_order(slots, active) {
		const a = Math.max(0, Math.min(active, slots.length - 1));
		return [a, ...slots.map((_, i) => i).filter(i => i !== a)];
	}

	async _barrier() {
		const marker = `inject-${++this.barrierId}`;
		this.streams.omniscient.write(`>chat ${marker}`);
		await this.inbox.omniscient.next(
			line => line.startsWith('|chat|') && line.includes(marker), 5000
		);
	}

	_edit(cmd) {
		this.streams.omniscient.write(`>editbattle ${cmd}`);
	}

	_applySideState(sideIndex, sideCfg, order, { full = true } = {}) {
		const side = this.battle.sides[sideIndex];
		const player = `p${sideIndex + 1}`;
		const key = player;
		(sideCfg.slots || []).forEach((slot, slotIndex) => {
			const mon = this.monBySlot[key].get(slotIndex);
			if (!mon) return;
			const pos = side.pokemon.indexOf(mon) + 1;
			if (!pos) return;

			const targetHp = slot.hpPercent !== undefined ?
				Math.round(mon.maxhp * slot.hpPercent / 100) :
				slot.hp !== undefined ? slot.hp : null;
			if (targetHp !== null) {
				if (targetHp <= 0) this.warnings.push(`${mon.species.name} 的 HP 设为 0 暂不支持，按 1 处理`);
				const hp = Math.max(1, Math.min(mon.maxhp, targetHp));
				if (hp !== mon.hp) this._edit(`hp ${player}, ${pos}, ${hp}`);
			}

			if (slot.status !== undefined && slot.status !== mon.status) {
				if (!slot.status) {
					mon.clearStatus();
				} else if (!mon.setStatus(slot.status)) {
					this.warnings.push(`${mon.species.name} 无法进入 ${slot.status} 状态（免疫或已失效）`);
				}
			}

			for (const [move, pp] of Object.entries(slot.pp || {})) {
				const moveSlot = mon.moveSlots.find(m => m.id === move.toLowerCase().replace(/[^a-z0-9]/g, ''));
				if (moveSlot && moveSlot.pp !== pp) this._edit(`pp ${player}, ${pos}, ${move}, ${pp}`);
			}

			if (mon.isActive) {
				for (const [stat, value] of Object.entries(slot.boosts || {})) {
					const clamped = Math.max(-6, Math.min(6, value));
					if (mon.boosts[stat] !== clamped) mon.boosts[stat] = clamped;
				}
				if (full) {
					for (const volatile of slot.volatiles || []) {
						if (!this.Sim.Dex.conditions.get(volatile).exists) {
							this.warnings.push(`${mon.species.name} 的附加状态 ${volatile} 不在当前数据包中`);
							continue;
						}
						if (!mon.volatiles[volatile]) this._edit(`volatile ${player}, ${pos}, ${volatile}`);
					}
				}
			}
		});
	}

	/**
	 * Some conditions reject a bare addVolatile() because they expect context a
	 * real move would supply: Encore/Disable need the affected move, Attract
	 * needs an opposing source. Seed that state directly so the sandbox can
	 * still hold the status.
	 */
	_ensureVolatiles(config) {
		for (const [key, sideCfg] of [['p1', config.p1], ['p2', config.p2]]) {
			(sideCfg.slots || []).forEach((slot, slotIndex) => {
				const mon = this.monBySlot[key].get(slotIndex);
				if (!mon || !mon.isActive) return;
				for (const id of slot.volatiles || []) {
					if (mon.volatiles[id]) continue;
					const cond = this.Sim.Dex.conditions.get(id);
					if (!cond.exists || cond.effectType !== 'Condition') continue;
					const state = this.battle.initEffectState({ id, name: cond.name, target: mon });
					if (cond.duration) state.duration = cond.duration;
					if (id === 'encore' || id === 'disable') {
						const move = mon.moveSlots[0];
						if (move) state.move = move.id;
					}
					if (id === 'attract') {
						const foe = mon.side.foe.active[0];
						if (foe) { state.source = foe; state.sourceSlot = foe.getSlot(); }
					}
					mon.volatiles[id] = state;
				}
			});
		}
	}

	_injectAll(config) {		this._applySideState(0, config.p1, this.orders.p1, { full: true });
		this._applySideState(1, config.p2, this.orders.p2, { full: true });
		const field = normalizeField(config.field);
		if (field.weather) this._edit(`weather ${field.weather}`);
		if (field.terrain) this._edit(`terrain ${field.terrain}`);
		for (const side of ['p1', 'p2']) {
			for (const condition of field[side].conditions) this._edit(`sidecondition ${side}, ${condition}`);
		}
	}

	_applyPatch(config) {
		this._applySideState(0, config.p1, this.orders.p1, { full: false });
		this._applySideState(1, config.p2, this.orders.p2, { full: false });
	}

	_needsRebuild(config) {
		if (structuralKey(config) !== this.structural) return true;
		const snapshot = this.snapshot;
		if (!snapshot) return true;
		if ((config.p1.active || 0) !== snapshot.p1.active) return true;
		if ((config.p2.active || 0) !== snapshot.p2.active) return true;

		const current = normalizeField(snapshot.field);
		const wanted = normalizeField(config.field);
		if (JSON.stringify(current) !== JSON.stringify(wanted)) return true;

		// Volatile edits (e.g. removing Substitute) cannot be patched in place.
		// Only the active Pokemon can carry them, so bench slots are ignored.
		for (const side of ['p1', 'p2']) {
			const activeSlot = snapshot[side].active;
			const mon = snapshot[side].pokemon.find(m => m.slot === activeSlot);
			if (!mon) continue;
			const slot = config[side].slots?.[activeSlot];
			const wanted = [...(slot?.volatiles || [])].sort();
			const current = [...mon.volatiles].sort();
			if (JSON.stringify(wanted) !== JSON.stringify(current)) return true;
		}
		return false;
	}

	async applyTurn({ config, choices = {} }) {
		if (this.ended) throw new Error('battle already ended; reset the session to continue');
		const beforeSnapshot = this.snapshot ? clone(this.snapshot) : null;
		this.warnings = [];
		const rebuilt = !this.battle || this._needsRebuild(config);
		let before = beforeSnapshot;
		if (rebuilt) {
			const keepPrng = !config.prngSeed && this.lastPrng;
			await this.close();
			await this.start(config);
			if (keepPrng) {
				// Structural rebuild shouldn't reroll the timeline: continue the PRNG
				// from where the previous battle left off.
				this.streams.omniscient.write(`>editbattle reseed ${this.lastPrng}`);
				await this._barrier();
			}
			before = clone(this.snapshot);
		} else {
			this._applyPatch(config);
			await this._barrier();
			// The formatter needs the post-injection state so damage/heal deltas
			// are computed against the injected HP, not the pre-injection snapshot.
			before = this.readState();
		}

		const eventStart = this.inbox.omniscient.lines.length;
		const prngSeed = this.battle.prng.getSeed();

		const switchPos = (sideIndex, slot) => {
			const key = `p${sideIndex + 1}`;
			const mon = this.monBySlot[key].get(slot);
			return mon ? this.battle.sides[sideIndex].pokemon.indexOf(mon) + 1 : 0;
		};

		try {
			this.streams.p1.write(choiceToString(choices.p1, slot => switchPos(0, slot)));
			this.streams.p2.write(choiceToString(choices.p2, slot => switchPos(1, slot)));
		} catch (err) {
			throw new Error(`invalid choice: ${err.message}`);
		}

		let req1;
		let req2;
		try {
			req1 = await this._nextRequest('p1');
			req2 = await this._nextRequest('p2');
			for (let guard = 0; guard < 4; guard++) {
				let switched = false;
				if (req1?.forceSwitch) {
					const pos = this._aliveBench(0);
					if (pos) { this.streams.p1.write(`switch ${pos}`); switched = true; }
				}
				if (req2?.forceSwitch) {
					const pos = this._aliveBench(1);
					if (pos) { this.streams.p2.write(`switch ${pos}`); switched = true; }
				}
				if (!switched) break;
				if (req1?.forceSwitch) req1 = await this._nextRequest('p1');
				if (req2?.forceSwitch) req2 = await this._nextRequest('p2');
			}
		} catch (err) {
			const detail = [...this.inbox.p1.errors(), ...this.inbox.p2.errors()].join(' | ');
			throw new Error(`${err.message}${detail ? ` (${detail})` : ''}`);
		}

		const events = this.inbox.omniscient.lines.slice(eventStart).filter(line =>
			!line.startsWith('|t:|') && !line.startsWith('|html|') &&
			!line.startsWith('|request|') && !line.startsWith('|chat|')
		);
		this.turn++;
		this.snapshot = this.readState();
		this.lastPrng = this.battle.prng.getSeed();
		this.requests = { p1: req1, p2: req2 };
		this.ended = events.some(line => line.startsWith('|win|') || line.startsWith('|tie|')) ||
			!req1 || !req2;

		return {
			turn: this.turn,
			rebuilt,
			ended: this.ended,
			prngSeed,
			events,
			before,
			warnings: this.warnings,
			after: this.snapshot,
			requests: this.requests,
		};
	}

	_aliveBench(sideIndex) {
		const side = this.battle.sides[sideIndex];
		const active = side.active[0];
		const activePos = active ? side.pokemon.indexOf(active) : -1;
		for (let pos = 0; pos < side.pokemon.length; pos++) {
			if (pos === activePos) continue;
			if (side.pokemon[pos]?.hp > 0) return pos + 1;
		}
		return null;
	}

	async _nextRequest(sideKey) {
		const line = await this.inbox[sideKey].next(isRequest);
		return line ? parseRequest(line) : null;
	}

	readState() {
		const readSide = (sideIndex, key) => {
			const side = this.battle.sides[sideIndex];
			const slotOf = mon => {
				const slot = this.slotMaps[key].get(mon);
				return slot === undefined ? -1 : slot;
			};
			const activePos = side.active[0] ? side.pokemon.indexOf(side.active[0]) : -1;
			return {
				active: side.active[0] ? slotOf(side.active[0]) : -1,
				activePos,
				pokemon: side.pokemon.map(mon => ({
					slot: slotOf(mon),
					species: mon.species.name,
					level: mon.level,
					hp: mon.hp,
					maxhp: mon.maxhp,
					status: mon.status,
					fainted: mon.fainted,
					boosts: { ...mon.boosts },
					moves: mon.moveSlots.map(m => ({ move: m.move, id: m.id, pp: m.pp, maxpp: m.maxpp })),
					volatiles: Object.keys(mon.volatiles),
					item: mon.item,
					ability: mon.ability,
				})),
				conditions: Object.keys(side.sideConditions).sort(),
			};
		};
		return {
			p1: readSide(0, 'p1'),
			p2: readSide(1, 'p2'),
			field: {
				weather: this.battle.field.weather || '',
				terrain: this.battle.field.terrain || '',
				p1: { conditions: Object.keys(this.battle.sides[0].sideConditions).sort() },
				p2: { conditions: Object.keys(this.battle.sides[1].sideConditions).sort() },
			},
		};
	}

	async close() {
		if (this.stream) {
			try { await this.stream.destroy(); } catch {}
		}
		this.stream = null;
		this.streams = null;
		this.inbox = null;
		this.battle = null;
	}
}

module.exports = { BattleSession, loadEngine, normalizeSet, normalizeField };
