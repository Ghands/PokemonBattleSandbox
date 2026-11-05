'use strict';

/** Turn PS protocol lines into compact Chinese text for the middle column. */

const clean = ident => String(ident || '').replace(/^p[1-4][a-z]?: /, '');

const STATUS_NAMES = {
	brn: '灼伤', par: '麻痹', slp: '睡眠', psn: '中毒', tox: '剧毒', frz: '冰冻', fnt: '濒死',
};

const BOOST_NAMES = {
	atk: '攻击', def: '防御', spa: '特攻', spd: '特防', spe: '速度', accuracy: '命中', evasion: '闪避',
};

const CANT_REASONS = {
	par: '麻痹', slp: '睡眠', frz: '冰冻', flinch: '畏缩', confusion: '混乱', attract: '着迷', recharge: '需要休息',
};

const TYPE_NAMES = {
	Normal: '一般', Fire: '火', Water: '水', Grass: '草', Electric: '电', Ice: '冰',
	Fighting: '格斗', Poison: '毒', Ground: '地面', Flying: '飞行', Psychic: '超能力',
	Bug: '虫', Rock: '岩石', Ghost: '幽灵', Dragon: '龙', Dark: '恶', Steel: '钢', Fairy: '妖精',
};

function stripPrefix(text) {
	return String(text || '').replace(/^move: /, '').replace(/^ability: /, '').replace(/^item: /, '');
}

function formatEvents(events, names = {}, before = null) {
	const sp = name => names.species?.[name] || name;
	const mv = name => names.moves?.[name] || name;

	// Track exact HP so damage lines read "损失 87 点" instead of "65/100".
	const hpState = new Map();
	if (before) {
		for (const side of ['p1', 'p2']) {
			for (const mon of before[side]?.pokemon || []) {
				hpState.set(`${side}:${mon.species}`, { hp: mon.hp, maxhp: mon.maxhp });
			}
		}
	}
	const identKey = ident => {
		const m = /^(p[1-4])[a-z]?: (.+)$/.exec(String(ident || ''));
		return m ? `${m[1]}:${m[2]}` : null;
	};
	const getHp = ident => hpState.get(identKey(ident));
	const setFromCondition = (ident, condition) => {
		const st = getHp(ident);
		if (!st) return null;
		const [hpText] = String(condition).split(' ');
		if (hpText === '0' || hpText === '0/100' || String(condition).includes('fnt')) {
			st.hp = 0;
			return st;
		}
		const [cur, max] = hpText.split('/').map(Number);
		if (!Number.isFinite(cur)) return st;
		if (Number.isFinite(max) && max > 0) {
			st.maxhp = st.maxhp || max;
			st.hp = Math.round(st.maxhp * cur / max);
		} else {
			st.hp = cur;
		}
		return st;
	};

	const lines = [];
	for (const raw of events) {
		const p = raw.split('|');
		const cmd = p[1];
		switch (cmd) {
		case 'turn':
			// The app owns turn numbering; engine turn is always 1 after a rebuild.
			break;
		case 'move': {
			const user = sp(clean(p[2]));
			const target = p[4] ? sp(clean(p[4])) : '';
			lines.push(`${user} 使用 ${mv(stripPrefix(p[3]))}${target && target !== user ? ` → ${target}` : ''}`);
			break;
		}
		case 'switch': {
			const species = sp((p[3] || '').split(',')[0].trim());
			const st = getHp(p[2]);
			if (st && p[4]) {
				const [cur, max] = String(p[4]).split('/').map(Number);
				if (Number.isFinite(cur)) st.hp = cur;
				if (Number.isFinite(max) && max > 0) st.maxhp = st.maxhp || max;
			}
			lines.push(`${sp(clean(p[2]))} 换上 ${species}${p[4] ? `（${p[4]}）` : ''}`);
			break;
		}
		case 'drag':
			lines.push(`${sp(clean(p[2]))} 被拖上场 ${sp(clean(p[3]))}`);
			break;
		case '-damage': {
			const st = getHp(p[2]);
			const oldHp = st?.hp;
			const next = setFromCondition(p[2], p[3]);
			if (next && oldHp !== undefined) {
				const dealt = Math.max(0, oldHp - next.hp);
				lines.push(`${sp(clean(p[2]))} 受到 ${dealt} 点伤害（${next.hp}/${next.maxhp}）`);
			} else {
				lines.push(`${sp(clean(p[2]))} 受伤 → ${p[3]}${p[4] ? ` ${p[4]}` : ''}`);
			}
			break;
		}
		case '-heal': {
			const st = getHp(p[2]);
			const oldHp = st?.hp;
			const next = setFromCondition(p[2], p[3]);
			if (next && oldHp !== undefined) {
				const healed = Math.max(0, next.hp - oldHp);
				lines.push(`${sp(clean(p[2]))} 回复 ${healed} 点（${next.hp}/${next.maxhp}）`);
			} else {
				lines.push(`${sp(clean(p[2]))} 回复 → ${p[3]}`);
			}
			break;
		}
		case '-sethp': {
			const next = setFromCondition(p[2], p[3]);
			lines.push(`${sp(clean(p[2]))} HP 变为 ${next ? `${next.hp}/${next.maxhp}` : p[3]}`);
			break;
		}
		case '-status':
			lines.push(`${sp(clean(p[2]))} 陷入${STATUS_NAMES[p[3]] || p[3]}状态`);
			break;
		case '-curestatus':
			lines.push(`${sp(clean(p[2]))} 的${STATUS_NAMES[p[3]] || p[3]}状态解除`);
			break;
		case '-boost':
			lines.push(`${sp(clean(p[2]))} 的${BOOST_NAMES[p[3]] || p[3]}提升 ${p[4]} 级`);
			break;
		case '-unboost':
			lines.push(`${sp(clean(p[2]))} 的${BOOST_NAMES[p[3]] || p[3]}下降 ${p[4]} 级`);
			break;
		case '-setboost':
			lines.push(`${sp(clean(p[2]))} 的${BOOST_NAMES[p[3]] || p[3]}变为 ${p[4]} 级`);
			break;
		case '-crit':
			lines.push('击中要害！');
			break;
		case '-supereffective':
			lines.push('效果绝佳！');
			break;
		case '-resisted':
			lines.push('效果不佳……');
			break;
		case '-immune':
			lines.push(`${sp(clean(p[2]))} 没有受到效果`);
			break;
		case '-miss':
			lines.push(`${sp(clean(p[2]))} 没有命中`);
			break;
		case 'faint': {
			const st = getHp(p[2]);
			if (st) st.hp = 0;
			lines.push(`${sp(clean(p[2]))} 倒下了！`);
			break;
		}
		case 'cant':
			lines.push(`${sp(clean(p[2]))} 无法行动（${CANT_REASONS[p[3]] || p[3]}）`);
			break;
		case '-fail':
			lines.push(`${sp(clean(p[2]))} 使用失败`);
			break;
		case '-activate':
			lines.push(`${sp(clean(p[2]))} 发动 ${mv(stripPrefix(p[3]))}`);
			break;
		case '-enditem':
			lines.push(`${sp(clean(p[2]))} 失去了 ${stripPrefix(p[3])}`);
			break;
		case '-item':
			lines.push(`${sp(clean(p[2]))} 获得了 ${stripPrefix(p[3])}`);
			break;
		case '-ability':
			lines.push(`${sp(clean(p[2]))} 的特性 ${stripPrefix(p[3])} 发动了`);
			break;
		case '-endability':
			lines.push(`${sp(clean(p[2]))} 的特性 ${stripPrefix(p[3])} 被无效化`);
			break;
		case '-weather':
			lines.push(`天气变为 ${stripPrefix(p[2])}`);
			break;
		case '-fieldstart':
			lines.push(`场地变为 ${stripPrefix(p[2])}`);
			break;
		case '-fieldend':
			lines.push(`场地 ${stripPrefix(p[2])} 结束`);
			break;
		case '-sidestart':
			lines.push(`${sp(clean(p[2]))} 展开 ${mv(stripPrefix(p[3]))}`);
			break;
		case '-sideend':
			lines.push(`${sp(clean(p[2]))} 的 ${mv(stripPrefix(p[3]))} 结束`);
			break;
		case '-start':
			lines.push(`${sp(clean(p[2]))} 进入 ${stripPrefix(p[3])} 状态`);
			break;
		case '-end':
			lines.push(`${sp(clean(p[2]))} 的 ${stripPrefix(p[3])} 状态结束`);
			break;
		case '-singleturn':
			break;
		case '-terastallize':
			lines.push(`${sp(clean(p[2]))} 太晶化为 ${TYPE_NAMES[p[3]] || p[3]}属性`);
			break;
		case 'win':
			lines.push(`${sp(clean(p[2]))} 获胜！`);
			break;
		case 'tie':
			lines.push('平局');
			break;
		case 'upkeep':
		case 't:':
		case 'html':
		case 'request':
			break;
		default:
			// Unknown commands are kept for debugging but not shown in the main view.
			break;
		}
	}
	return lines;
}

module.exports = { formatEvents, clean };
