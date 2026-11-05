'use strict';

/**
 * UI smoke test with jsdom against the running dev server.
 * Checks the three review points:
 *   1. picked species / moves render as Chinese
 *   2. picking a species does NOT auto-fill a set
 *   3. slot summary shows the species types
 */

const { JSDOM } = require('jsdom');

const BASE = 'http://127.0.0.1:8931/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const html = await (await fetch(BASE)).text();
	const dom = new JSDOM(html, {
		url: BASE,
		runScripts: 'dangerously',
		resources: 'usable',
		pretendToBeVisual: true,
		beforeParse(window) {
			window.fetch = (url, opts) => fetch(new URL(url, BASE), opts);
			window.confirm = () => true;
		},
	});
	const { window } = dom;
	const doc = window.document;

	for (let i = 0; i < 100 && !window.__app?.getCatalog(); i++) await sleep(100);
	if (!window.__app?.getCatalog()) throw new Error('app did not boot (catalog missing)');
	await sleep(200);

	const app = window.__app;
	const cat = app.getCatalog();
	const garchomp = cat.species.find(s => s.id === 'garchomp');

	// (2) pick species -> no auto set
	app.pick('p1', 0, garchomp);
	await sleep(100);
	const slot = app.getState().p1.slots[0];
	const filled = slot.moves.filter(Boolean);
	console.log('moves after pick:', JSON.stringify(filled), filled.length === 0 ? 'OK (no auto set)' : 'FAIL');

	// (1) species displayed in Chinese
	const combos = doc.querySelectorAll('#side-p1 .combo input');
	const speciesValue = combos[0].value;
	console.log('species input:', speciesValue, speciesValue === '烈咬陆鲨' ? 'OK' : 'FAIL');

	// (3) summary shows types
	const row = doc.querySelector('#side-p1 .slotrow .nm').textContent;
	console.log('slot summary:', row, row.includes('龙/地面') ? 'OK' : 'FAIL');

	// (1) move pick shows Chinese
	slot.moves[0] = 'Earthquake';
	slot.moves[1] = 'Dragon Claw';
	app.renderAll();
	await sleep(50);
	const comboInputs = doc.querySelectorAll('#side-p1 .combo input');
	console.log('move input 1:', comboInputs[2].value, comboInputs[2].value === '地震' ? 'OK' : 'FAIL');
	console.log('move input 2:', comboInputs[3].value, comboInputs[3].value === '龙爪' ? 'OK' : 'FAIL');

	// auto set remains available as an explicit action
	await app.autoSet('p1', 0);
	await sleep(100);
	const autoMoves = app.getState().p1.slots[0].moves.filter(Boolean);
	console.log('manual auto-set fills:', autoMoves.join('/'), autoMoves.length === 4 ? 'OK' : 'FAIL');

	// volatile status editor: common chips + search over the full catalog
	let chips = doc.querySelectorAll('#side-p1 .chips .chip');
	console.log('volatile chips (common):', chips.length, chips.length > 20 ? 'OK' : 'FAIL');

	const substitute = [...chips].find(c => c.textContent === '替身');
	if (substitute) substitute.click();
	await sleep(30);
	const hasSub = app.getState().p1.slots[0].volatiles.includes('substitute');
	console.log('toggle 替身:', hasSub ? 'OK' : 'FAIL');

	const search = doc.querySelector('#side-p1 .volsearch');
	search.value = '再来';
	search.dispatchEvent(new window.Event('input', { bubbles: true }));
	await sleep(30);
	chips = doc.querySelectorAll('#side-p1 .chips .chip');
	const encore = [...chips].find(c => c.textContent === '再来一次');
	console.log('search 再来一次:', encore ? 'OK' : 'FAIL');
	if (encore) encore.click();
	await sleep(30);
	const vols = app.getState().p1.slots[0].volatiles;
	console.log('selected volatiles:', vols.join(','), vols.includes('encore') ? 'OK' : 'FAIL');

	// labelled EV / IV / boost grids: every cell carries its stat name
	const grpHeads = [...doc.querySelectorAll('#side-p1 .statgrp .grphead span:first-child')].map(n => n.textContent);
	console.log('stat groups:', grpHeads.join(' / '), grpHeads.join(',') === '努力值 EV,个体值 IV,能力变化' ? 'OK' : 'FAIL');
	const capOf = sel => [...doc.querySelectorAll(sel)].map(n => n.textContent);
	const evCaps = [...doc.querySelectorAll('#side-p1 .statgrp')[0].querySelectorAll('.cell .cap')].map(n => n.textContent);
	console.log('EV captions:', evCaps.join('/'), evCaps.length === 6 && evCaps[0] === 'HP' && evCaps[3] === '特攻' ? 'OK' : 'FAIL');
	const boostCaps = capOf('#side-p1 .statgrp .statgrid.wide .cell .cap');
	console.log('boost captions:', boostCaps.join('/'),
		boostCaps.length === 7 && boostCaps.includes('闪避') && boostCaps.includes('命中') ? 'OK' : 'FAIL');

	// settings sheet: per-side hide
	doc.querySelector('#btn-settings').click();
	const boxes = [...doc.querySelectorAll('#settings-body .setcell input')];
	console.log('settings checkboxes:', boxes.length, boxes.length === 8 && boxes.every(b => b.checked) ? 'OK' : 'FAIL');
	boxes[0].click(); // 行序：p1 努力值、p2 努力值、p1 个体值、p2 个体值、p1 能力变化…
	boxes[4].click(); // p1 能力变化
	boxes[6].click(); // p1 六维数值汇总
	await sleep(30);
	const heads2 = [...doc.querySelectorAll('#side-p1 .statgrp .grphead span:first-child')].map(n => n.textContent);
	console.log('p1 after hide:', heads2.join('/'), heads2.join(',') === '个体值 IV' ? 'OK' : 'FAIL');
	console.log('p1 stats line hidden:', !doc.querySelector('#stats-p1-0') ? 'OK' : 'FAIL');
	const p2Heads = [...doc.querySelectorAll('#side-p2 .statgrp .grphead span:first-child')].map(n => n.textContent);
	console.log('p2 unaffected:', p2Heads.join('/'), p2Heads.length === 3 ? 'OK' : 'FAIL');
	const saved = JSON.parse(window.localStorage.getItem('pbsim-doc'));
	console.log('settings persisted:', JSON.stringify(saved.show?.p1),
		saved.show?.p1.evs === false && saved.show?.p1.ivs === true && saved.show?.p2.evs === true ? 'OK' : 'FAIL');
	doc.querySelector('#settings-close').click();
	console.log('sheet closed:', doc.querySelector('#settings').hidden ? 'OK' : 'FAIL');

	window.close();
})().catch(err => { console.error('SMOKE FAIL:', err); process.exit(1); });
