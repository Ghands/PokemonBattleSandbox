'use strict';
/**
 * Regression test for the settings / engine-manager features:
 *   1. engine-manager: settings persistence, relocation, tar extraction,
 *      GitHub check and the "already latest" short-circuit (mocked network).
 *   2. renderer UI: clear-battle button, settings tabs, data settings panel,
 *      update / relocate actions through a stubbed `pbsim.app` bridge.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const https = require('https');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const { createEngineManager, extractTarGz } = require(path.join(ROOT, 'electron', 'engine-manager.cjs'));
const { createEngineHost } = require(path.join(ROOT, 'app', 'bridge.cjs'));

const sleep = ms => new Promise(r => setTimeout(r, ms));
let failures = 0;
function check(label, cond, extra) {
	console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}${extra ? '  ' + extra : ''}`);
	if (!cond) failures++;
}

function makeTarGz(files) {
	const blocks = [];
	for (const f of files) {
		const head = Buffer.alloc(512);
		head.write(f.name, 0, 100, 'utf8');
		head.write('0000644\0', 100, 8);
		head.write('0000000\0', 108, 8);
		head.write('0000000\0', 116, 8);
		head.write(f.body.length.toString(8).padStart(11, '0') + '\0', 124, 12);
		head.write('00000000000\0', 136, 12);
		head.fill(32, 148, 156);
		head[156] = '0'.charCodeAt(0);
		head.write('ustar\0', 257, 6);
		head.write('00', 263, 2);
		const body = Buffer.from(f.body, 'utf8');
		blocks.push(head, body, Buffer.alloc((512 - body.length % 512) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(blocks));
}

function mockGithub() {
	const original = https.get;
	const calls = [];
	const REMOTE_SHA = 'a'.repeat(40);
	https.get = (url, _opts, cb) => {
		calls.push(url);
		const req = new EventEmitter();
		req.destroy = () => {};
		const res = new Readable({ read() {} });
		res.statusCode = 200;
		res.headers = {};
		let body = '';
		if (url.includes('/commits/')) {
			body = JSON.stringify({ sha: REMOTE_SHA, commit: { committer: { date: '2026-11-04T06:08:04Z' } } });
		} else if (url.includes('/contents/package.json')) {
			body = JSON.stringify({ content: Buffer.from(JSON.stringify({ version: '1.2.3' })).toString('base64') });
		}
		process.nextTick(() => { res.push(body); res.push(null); cb(res); });
		return req;
	};
	return { restore: () => { https.get = original; }, calls, REMOTE_SHA };
}

async function testEngineManager() {
	console.log('\n== engine-manager ==');
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-mgr-'));
	const userData = path.join(tmp, 'userdata');
	const projectRoot = path.join(tmp, 'project');
	const fakeEngine = path.join(projectRoot, 'pokemon-showdown-master');
	fs.mkdirSync(path.join(fakeEngine, 'dist', 'sim'), { recursive: true });
	fs.writeFileSync(path.join(fakeEngine, 'dist', 'sim', 'index.js'), 'module.exports = { ok: true };\n');
	fs.writeFileSync(path.join(fakeEngine, 'package.json'), JSON.stringify({ version: '1.0.0' }));
	fs.mkdirSync(path.join(fakeEngine, 'node_modules', 'ts-chacha20'), { recursive: true });
	fs.writeFileSync(path.join(fakeEngine, 'node_modules', 'ts-chacha20', 'package.json'), '{}');

	const manager = createEngineManager({ userDataPath: userData, resourcesPath: null, projectRoot });
	const info = manager.getInfo();
	check('默认引擎目录解析', info.engineDir === fakeEngine, info.engineDir);
	check('引擎版本读取', info.version === '1.0.0');
	check('初始无同步基准', info.meta === null);

	const movedParent = path.join(tmp, 'relocated');
	const moved = await manager.moveEngine(movedParent);
	check('移动引擎返回新位置', moved.moved === true && moved.engineDir === path.join(movedParent, 'engine'));
	check('新位置包含引擎入口', fs.existsSync(path.join(moved.engineDir, 'dist', 'sim', 'index.js')));
	check('新位置保留运行时依赖', fs.existsSync(path.join(moved.engineDir, 'node_modules', 'ts-chacha20', 'package.json')));
	check('原位置已清理', !fs.existsSync(fakeEngine));
	check('设置持久化', manager.readSettings().engineDir === moved.engineDir);
	check('重启后沿用新位置', manager.engineDir() === moved.engineDir);

	const tarDir = path.join(tmp, 'tar');
	fs.mkdirSync(tarDir, { recursive: true });
	const tgz = path.join(tarDir, 'sample.tar.gz');
	fs.writeFileSync(tgz, makeTarGz([
		{ name: 'repo/data/pokedex.ts', body: 'export const Pokedex = {};' },
		{ name: 'repo/../escape.txt', body: 'must not escape' },
	]));
	const extractDir = path.join(tarDir, 'out');
	const count = extractTarGz(tgz, extractDir);
	check('tar.gz 解压', count === 2 && fs.existsSync(path.join(extractDir, 'repo', 'data', 'pokedex.ts')));
	check('解压防目录穿越', !fs.existsSync(path.join(tarDir, 'escape.txt')));

	const gh = mockGithub();
	try {
		const checkResult = await manager.checkUpdate();
		check('GitHub 检查返回 sha', checkResult.remoteSha === gh.REMOTE_SHA);
		check('无基准时判定需更新', checkResult.hasUpdate === true);
		manager.writeMeta({ sha: gh.REMOTE_SHA, version: '1.2.3', syncedAt: new Date().toISOString() });
		const callsBefore = gh.calls.length;
		const result = await manager.updateEngine();
		check('已是最新版本时短路', result.updated === false && result.message === '已是最新版本');
		check('短路时不下载源码', gh.calls.length === callsBefore + 2 && !gh.calls.slice(callsBefore).some(u => u.includes('codeload')));
	} finally {
		gh.restore();
	}
	fs.rmSync(tmp, { recursive: true, force: true });
}

async function testRenderer() {
	console.log('\n== renderer UI ==');
	const host = createEngineHost();
	const html = fs.readFileSync(path.join(ROOT, 'app', 'public', 'index.html'), 'utf8')
		.replace('<link rel="stylesheet" href="/app.css">', '')
		.replace('<script src="/app.js"></script>', '');
	const appJs = fs.readFileSync(path.join(ROOT, 'app', 'public', 'app.js'), 'utf8');

	let engineDir = 'C:\\Program Files\\PokemonBattleSim\\resources\\engine';
	const appCalls = [];
	let progressCb = null;
	const dom = new JSDOM(html, {
		url: 'http://127.0.0.1:8931/',
		runScripts: 'dangerously',
		pretendToBeVisual: true,
		beforeParse(window) {
			window.confirm = () => true;
			window.pbsim = {
				rpc: async (method, params) => {
					try { return { ok: true, result: await host.rpcQueued(method, params) }; }
					catch (err) { return { ok: false, error: err.message }; }
				},
				app: async (method, params) => {
					appCalls.push({ method, params });
					try {
						switch (method) {
							case 'getEngineInfo':
								return { ok: true, result: { engineDir, version: '0.11.11', meta: null, writable: true } };
							case 'chooseEngineDir':
								return { ok: true, result: 'D:\\MyData' };
							case 'moveEngine':
								engineDir = 'D:\\MyData\\engine';
								return { ok: true, result: { moved: true, engineDir, message: '引擎位置已更新' } };
							case 'updateEngine':
								return { ok: true, result: { updated: false, message: '已是最新版本' } };
							default:
								return { ok: false, error: 'unknown method ' + method };
						}
					} catch (err) { return { ok: false, error: err.message }; }
				},
				onEngineProgress: cb => { progressCb = cb; return () => {}; },
			};
		},
	});
	const { window } = dom;
	const doc = window.document;
	window.eval(appJs);
	for (let i = 0; i < 150 && !window.__app?.getCatalog(); i++) await sleep(100);
	if (!window.__app?.getCatalog()) throw new Error('app did not boot');
	const app = window.__app;
	const $ = s => doc.querySelector(s);

	const buttons = [...doc.querySelectorAll('#mid .bar button')].map(b => b.textContent);
	check('中间栏出现清空对战按钮', buttons.some(t => t.includes('清空对战')), buttons.join(' | '));

	app.pick('p1', 0, app.getCatalog().species.find(s => s.id === 'garchomp'));
	app.pick('p2', 0, app.getCatalog().species.find(s => s.id === 'snorlax'));
	await sleep(60);
	const s1 = app.getState().p1.slots[0], s2 = app.getState().p2.slots[0];
	s1.moves[0] = 'Earthquake';
	s2.moves[0] = 'Body Slam';
	app.renderAll();
	await app.resolve();
	await sleep(200);
	check('结算产生一个回合', app.getState().turns.length === 1);

	const clearBtn = [...doc.querySelectorAll('#mid .bar button')].find(b => b.textContent.includes('清空对战'));
	clearBtn.click();
	await sleep(300);
	check('清空后无回合记录', app.getState().turns.length === 0);
	check('清空后会话已释放', app.getState().sessionId === null);
	check('清空后显示空记录提示', /还没有回合记录/.test($('#turns').textContent));

	$('#btn-settings').click();
	check('默认打开界面设置', !$('#settings-ui').hidden && $('#settings-data').hidden);
	check('界面设置保留 EV/IV 选项', /努力值/.test($('#settings-body').textContent));
	$('#tab-data').click();
	await sleep(150);
	check('切换到数据设置', $('#settings-ui').hidden && !$('#settings-data').hidden);
	check('数据设置显示当前引擎路径', $('#engine-path').value.includes('resources\\engine'), $('#engine-path').value);
	check('tab 高亮切换', $('#tab-data').classList.contains('cur') && !$('#tab-ui').classList.contains('cur'));
	check('进度回调已注册', typeof progressCb === 'function');
	if (progressCb) progressCb({ stage: 'build', text: '正在编译…', percent: 40 });
	check('进度条可更新', !$('#engine-progress').hidden && $('#engine-progress-bar').style.width === '40%');

	$('#btn-engine-update').click();
	for (let i = 0; i < 60 && !/已是最新版本/.test($('#engine-update-status').textContent); i++) await sleep(100);
	check('无更新时提示已是最新版本', /已是最新版本/.test($('#engine-update-status').textContent));
	check('更新调用了 updateEngine', appCalls.some(c => c.method === 'updateEngine'));
	check('更新结束后按钮可用', $('#btn-engine-update').disabled === false);

	$('#btn-engine-move').click();
	for (let i = 0; i < 60 && !$('#engine-path').value.includes('D:\\MyData'); i++) await sleep(100);
	check('更改位置调用 moveEngine', appCalls.some(c => c.method === 'moveEngine' && c.params.dir === 'D:\\MyData'));
	check('更改位置后显示新路径', $('#engine-path').value === 'D:\\MyData\\engine', $('#engine-path').value);

	host.close();
	window.close();
}

(async () => {
	await testEngineManager();
	await testRenderer();
	console.log(`\n${failures ? 'FAILED: ' + failures : 'ALL PASSED'}`);
	process.exit(failures ? 1 : 0);
})().catch(err => { console.error('TEST ERROR:', err); process.exit(1); });
