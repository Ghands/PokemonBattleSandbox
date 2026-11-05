'use strict';
/**
 * Regression test for the HarmonyOS PC packaging path.
 *   npm run test:ohos
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const { buildOhosConfig, REQUIRED_ENV, DEFAULT_APP_ID } = require('../tools/ohos-config.cjs');
const { prepareOhosHap } = require('../tools/prepare-ohos-hap.cjs');
const { createInProcessHost, resolveEngineDir } = require('../app/bridge.cjs');

let passed = 0;
function ok(name, fn) {
	fn();
	passed++;
	console.log('OK  ', name);
}

const BASE_ENV = {
	OHOS_HVIGORW_PATH: '/opt/deveco/tools/hvigor/bin',
	OHOS_OHPM_PATH: '/opt/deveco/tools/ohpm/bin',
	OHOS_SDK_PATH: '/opt/deveco/sdk',
	OHOS_HAP_PATH: '/opt/libelectron/ohos_hap',
};

ok('配置基础字段（asar/npmRebuild/无 Windows 专有键）', () => {
	const c = buildOhosConfig({ ...BASE_ENV }, ROOT);
	assert.strictEqual(c.asar, false);
	assert.strictEqual(c.npmRebuild, false);
	assert.strictEqual(c.appId, DEFAULT_APP_ID);
	assert.strictEqual(c.productName, 'PokemonBattleSim');
	assert.deepStrictEqual(c.ohos.target, ['hap']);
	assert.strictEqual(c.ohos.hvigorwPath, BASE_ENV.OHOS_HVIGORW_PATH);
	for (const key of ['win', 'nsis', 'portable', 'mac', 'linux']) {
		assert.ok(!(key in c), `不应包含 ${key}`);
	}
	for (const f of ['electron/**/*', 'app/**/*', 'engine-host/**/*', 'package.json']) {
		assert.ok(c.files.includes(f));
	}
});

ok('引擎作为 external resources，且只包含实际存在的路径', () => {
	const c = buildOhosConfig({ ...BASE_ENV }, ROOT);
	const tos = c.extraResources.map(r => r.to);
	assert.ok(tos.includes('engine/dist'));
	assert.ok(tos.includes('engine/package.json'));
	assert.ok(tos.includes('engine/node_modules/ts-chacha20'));
	for (const r of c.extraResources) {
		assert.ok(fs.existsSync(path.join(ROOT, r.from)), `资源应存在: ${r.from}`);
	}
});

ok('缺少必需环境变量时报错', () => {
	for (const key of REQUIRED_ENV) {
		const env = { ...BASE_ENV };
		delete env[key];
		assert.throws(() => buildOhosConfig(env, ROOT), new RegExp(key));
	}
});

ok('OHOS_TARGET=app / OHOS_APP_ID 覆盖生效', () => {
	const c = buildOhosConfig({ ...BASE_ENV, OHOS_TARGET: 'app', OHOS_APP_ID: 'com.example.pbs' }, ROOT);
	assert.deepStrictEqual(c.ohos.target, ['app']);
	assert.strictEqual(c.appId, 'com.example.pbs');
});

ok('签名信息必须完整', () => {
	assert.throws(() => buildOhosConfig({ ...BASE_ENV, OHOS_CERT_PATH: '/tmp/a.cer' }, ROOT), /不完整/);
	const c = buildOhosConfig({
		...BASE_ENV,
		OHOS_CERT_PATH: '/tmp/a.cer',
		OHOS_PROFILE: '/tmp/a.p7b',
		OHOS_KEY_ALIAS: 'alias',
		OH_KEY_PWD: 'pwd1',
		OHOS_STORE_FILE: '/tmp/a.p12',
		OH_STORE_PWD: 'pwd2',
	}, ROOT);
	assert.strictEqual(c.ohos.certPath, '/tmp/a.cer');
	assert.strictEqual(c.ohos.keyPassword, 'pwd1');
	assert.strictEqual(c.ohos.storePassword, 'pwd2');
});

ok('electron-builder.ohos.js 可被真实加载', () => {
	const saved = {};
	for (const k of Object.keys(BASE_ENV)) { saved[k] = process.env[k]; process.env[k] = BASE_ENV[k]; }
	try {
		const c = require('../electron-builder.ohos.js');
		assert.strictEqual(c.asar, false);
		assert.deepStrictEqual(c.ohos.target, ['hap']);
	} finally {
		for (const k of Object.keys(BASE_ENV)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
});

ok('底座工程整理：签名配置/包名/ACL 权限/中文标签', () => {
	const src = path.join(ROOT, '.ohos-build', 'test-source');
	const dest = path.join(ROOT, '.ohos-build', 'test-dest');
	fs.rmSync(src, { recursive: true, force: true });
	const put = (rel, text) => {
		const f = path.join(src, rel);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, text);
	};
	put('AppScope/app.json5', '{\n  "app": {\n    "bundleName": "com.example.old",\n    "vendor": "example"\n  }\n}\n');
	put('build-profile.json5', '{\n  "app": {\n    "signingConfigs": [\n      { "name": "default", "material": { "bundleName": "com.example.old" } }\n    ],\n    "products": []\n  }\n}\n');
	put('web_engine/src/main/module.json5', JSON.stringify({
		module: {
			requestPermissions: [
				{ name: 'ohos.permission.INTERNET' },
				{ name: 'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY' },
				{ name: 'ohos.permission.FILE_ACCESS_PERSIST' },
				{ name: 'ohos.permission.READ_PASTEBOARD' },
			],
		},
	}, null, 2));
	put('electron/src/main/resources/zh_CN/element/string.json',
		JSON.stringify({ string: [{ name: 'EntryAbility_label', value: 'HelloApp' }] }));

	const r = prepareOhosHap({ source: src, dest, bundle: 'local.pokemon.battlesim', label: '宝可梦对战沙盘' });
	assert.ok(fs.existsSync(path.join(dest, 'AppScope', 'app.json5')), '应复制整个工程');
	assert.ok(fs.existsSync(path.join(src, 'AppScope', 'app.json5')), '不应修改原始工程');

	const appJson5 = fs.readFileSync(path.join(dest, 'AppScope', 'app.json5'), 'utf8');
	assert.ok(appJson5.includes('"bundleName": "local.pokemon.battlesim"'), appJson5);
	assert.ok(!appJson5.includes('com.example.old'));

	const profile = fs.readFileSync(path.join(dest, 'build-profile.json5'), 'utf8');
	assert.ok(/["']?signingConfigs["']?\s*:\s*\[\s*\]/.test(profile), profile);
	assert.ok(profile.includes('"products"'));

	const moduleJson5 = fs.readFileSync(path.join(dest, 'web_engine', 'src', 'main', 'module.json5'), 'utf8');
	assert.ok(moduleJson5.includes('ohos.permission.INTERNET'));
	for (const p of require('../tools/prepare-ohos-hap.cjs').ACL_PERMISSIONS) {
		assert.ok(!moduleJson5.includes(p), `应移除 ${p}`);
	}
	JSON.parse(moduleJson5); // 清理后仍是合法 JSON

	const label = JSON.parse(fs.readFileSync(path.join(dest, 'electron', 'src', 'main', 'resources', 'zh_CN', 'element', 'string.json'), 'utf8'));
	assert.strictEqual(label.string[0].value, '宝可梦对战沙盘');

	fs.rmSync(src, { recursive: true, force: true });
	fs.rmSync(dest, { recursive: true, force: true });
});

(async () => {
	const explicit = path.resolve(ROOT, 'pokemon-showdown-master');
	assert.strictEqual(resolveEngineDir(explicit), explicit);

	const saved = process.env.PBSIM_ENGINE;
	process.env.PBSIM_ENGINE = explicit;
	try {
		assert.strictEqual(resolveEngineDir(), explicit);
	} finally {
		if (saved === undefined) delete process.env.PBSIM_ENGINE;
		else process.env.PBSIM_ENGINE = saved;
	}

	const host = createInProcessHost({ engineDir: explicit });
	assert.strictEqual(host.mode, 'in-process');
	assert.strictEqual(host.engineDir, explicit);
	const probe = await host.rpc('probe', {});
	assert.ok(probe.speciesCount > 1000);
	const config = {
		format: 'gen9customgame', seed: [1, 2, 3, 4],
		p1: { active: 0, slots: [{ species: 'Garchomp', name: 'Garchomp', moves: ['Earthquake'], level: 100 }] },
		p2: { active: 0, slots: [{ species: 'Snorlax', name: 'Snorlax', moves: ['Body Slam'], level: 100 }] },
	};
	const s = await host.rpc('createSession', { config });
	const r = await host.rpc('applyTurn', {
		sessionId: s.sessionId, config,
		choices: { p1: { kind: 'move', index: 0 }, p2: { kind: 'move', index: 0 } },
	});
	assert.strictEqual(r.turn, 1);
	assert.ok(r.text.length > 0);
	await host.close();
	passed++;
	console.log('OK   in-process host：引擎目录解析与真实 RPC');

	// Remove the temporary working dir if it is now empty.
	const work = path.join(ROOT, '.ohos-build');
	try { fs.rmdirSync(work); } catch { /* not empty / not ours */ }
	console.log(`\n${passed} checks passed`);
})().catch(err => {
	console.error('FAIL', err);
	process.exit(1);
});
