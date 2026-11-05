'use strict';

/**
 * Renderer <-> main IPC contract test.
 *
 * The Electron shell does not use the dev HTTP endpoint: the page gets
 * `window.pbsim.rpc(method, params)` from the preload script, which the main
 * process answers with `{ ok, result } | { ok:false, error }`. This test boots
 * the real page with a stubbed `window.pbsim.rpc` that forwards to the real
 * bridge, so the IPC branch in app.js is exercised end to end.
 */

const path = require('path');
const { JSDOM } = require('jsdom');
const { createEngineHost } = require('../app/bridge.cjs');

const BASE = 'http://127.0.0.1:8931/';
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
	const host = createEngineHost();
	let calls = 0;

	const html = await (await fetch(BASE)).text();
	const dom = new JSDOM(html, {
		url: BASE,
		runScripts: 'dangerously',
		resources: 'usable',
		pretendToBeVisual: true,
		beforeParse(window) {
			window.confirm = () => true;
			// Mimic electron/preload.cjs -> ipcMain 'pbsim:rpc'.
			window.pbsim = {
				rpc: async (method, params) => {
					calls++;
					try {
						return { ok: true, result: await host.rpcQueued(method, params) };
					} catch (err) {
						return { ok: false, error: err.message };
					}
				},
			};
		},
	});

	const { window } = dom;
	const doc = window.document;
	for (let i = 0; i < 120 && !window.__app?.getCatalog(); i++) await sleep(100);
	if (!window.__app?.getCatalog()) throw new Error('app did not boot over IPC bridge');

	const app = window.__app;
	console.log('catalog loaded via pbsim.rpc:', calls >= 2 ? 'OK' : 'FAIL', `(${calls} calls)`);

	// Configure a minimal battle and resolve one turn through the same channel.
	app.pick('p1', 0, app.getCatalog().species.find(s => s.id === 'garchomp'));
	app.pick('p2', 0, app.getCatalog().species.find(s => s.id === 'snorlax'));
	await sleep(50);
	const s1 = app.getState().p1.slots[0];
	const s2 = app.getState().p2.slots[0];
	s1.moves[0] = 'Earthquake';
	s2.moves[0] = 'Body Slam';
	app.renderAll();
	await app.resolve();
	await sleep(200);

	const turns = app.getState().turns;
	console.log('turn resolved:', turns.length, turns[0]?.text?.length ? 'OK' : 'FAIL');
	console.log('session created:', app.getState().sessionId ? 'OK' : 'FAIL');
	console.log(turns[0]?.text?.slice(0, 3).join(' / '));

	host.close();
	window.close();
	if (!turns.length) process.exit(1);
})().catch(err => { console.error('IPC TEST FAIL:', err); process.exit(1); });
