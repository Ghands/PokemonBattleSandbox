#!/usr/bin/env node
/**
 * 构建环境回归测试：便携 Node 的 PATH 注入 + Windows copyfile 文件占用容错
 *   node spike/build-env-test.cjs
 *
 * 覆盖在其他电脑上实测过的两个故障：
 *   (一) 安装 electron-winstaller 时「找不到 node 命令」；
 *   (二) 编译完引擎后 copyfile 遇到被锁定文件，原地重试多次都不解锁。
 * 不联网、不打包；只用临时目录。
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'tools', 'build-env.cjs'));
const NODE = process.execPath;
const NODE_DIR = path.dirname(NODE);
const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';
const NODE_BIN = IS_WIN ? 'node.exe' : 'node';

let passed = 0, failed = 0;
function t(name, fn) {
	try { fn(); passed++; console.log('  OK   ' + name); }
	catch (e) { failed++; console.log('  FAIL ' + name + '\n       ' + (e && e.message)); }
}
function tmpDir(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-env-' + tag + '-')); }

/** 造一份完全找不到 node 的 PATH（过滤掉所有含 node 可执行文件的目录）。 */
function bareEnv() {
	const p = (process.env.PATH || process.env.Path || '').split(PATH_SEP).filter(d => {
		if (!d) return false;
		try { return !fs.statSync(path.join(d, NODE_BIN)).isFile(); }
		catch { return true; }
	}).join(PATH_SEP);
	const env = { ...process.env };
	env.PATH = p;
	if ('Path' in env) env.Path = p;
	delete env.npm_node_execpath;
	return env;
}

console.log('\n=== 构建环境回归测试（PATH / 文件锁）===\n');

/* ---------------------------------- PATH ---------------------------------- */

t('withNodeOnPath：把当前 node 目录前置到 PATH，且保留原有项', () => {
	const base = { PATH: ['/usr/bin', '/bin'].join(PATH_SEP) };
	const out = E.withNodeOnPath(base);
	assert.strictEqual(out.PATH.split(PATH_SEP)[0], NODE_DIR);
	assert.ok(out.PATH.includes('/usr/bin'));
	assert.strictEqual(base.PATH, ['/usr/bin', '/bin'].join(PATH_SEP), '不应修改入参');
	assert.strictEqual(out.npm_node_execpath, NODE);
});

t('withNodeOnPath：幂等，不会重复插入 node 目录', () => {
	const once = E.withNodeOnPath({ PATH: '/usr/bin' });
	const twice = E.withNodeOnPath(once);
	assert.strictEqual(twice.PATH, once.PATH);
});

t('nodeCommandResolvable：去掉 node 目录后为 false，注入后为 true', () => {
	const bare = bareEnv();
	assert.strictEqual(E.nodeCommandResolvable(bare), false, '裸 PATH 不应解析出 node');
	assert.strictEqual(E.nodeCommandResolvable(E.withNodeOnPath(bare)), true);
});

t('applyNodeOnPath：就地修改 env，子进程可直接继承', () => {
	const env = bareEnv();
	const same = E.applyNodeOnPath(env);
	assert.strictEqual(same, env);
	assert.strictEqual(E.nodeCommandResolvable(env), true);
	assert.strictEqual(env.npm_node_execpath, NODE);
});

t('installNodeSpawnFallback：真 Node 环境下不装补丁（避免副作用）', () => {
	const env = bareEnv();
	const saved = process.env.PATH;
	try {
		process.env.PATH = env.PATH;
		assert.strictEqual(E.installNodeSpawnFallback(), false);
	} finally { process.env.PATH = saved; }
});

t('npm 生命周期脚本：裸 PATH 失败，注入 PATH 后成功（复现 electron-winstaller 安装）', () => {
	const npmCli = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npm-cli.js');
	if (!fs.existsSync(npmCli)) { console.log('       (跳过：当前 Node 发行版没有 npm-cli.js)'); return; }
	const dir = tmpDir('npm');
	try {
		fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
			name: 'pbsim-lifecycle-probe', version: '1.0.0',
			scripts: { probe: 'node ./probe.js' },
		}));
		// 模拟 electron-winstaller 的 "install": "node ./script/select-7z-arch.js"
		fs.writeFileSync(path.join(dir, 'probe.js'), "require('fs').writeFileSync('ok.txt', 'NODE_OK');\n");
		const marker = path.join(dir, 'ok.txt');
		const run = env => {
			try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }
			const r = spawnSync(NODE, [npmCli, 'run', 'probe'], { cwd: dir, env, encoding: 'utf8', timeout: 90000 });
			return { code: r.status, ok: fs.existsSync(marker), err: (r.stderr || '').slice(-300) };
		};
		const bare = run(bareEnv());
		assert.notStrictEqual(bare.ok, true, '裸 PATH 竟然能找到 node，测试前提不成立');
		const fixed = run(E.withNodeOnPath(bareEnv()));
		assert.strictEqual(fixed.code, 0, '注入 PATH 后 npm 脚本仍失败：' + fixed.err);
		assert.strictEqual(fixed.ok, true, '探针脚本没有执行');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('esbuild-wasm：裸 PATH 报 spawn node ENOENT，注入 PATH 后编译成功', () => {
	const wasmPkg = path.join(ROOT, 'node_modules', 'esbuild-wasm');
	if (!fs.existsSync(path.join(wasmPkg, 'esbuild.wasm'))) { console.log('       (跳过：未安装 esbuild-wasm)'); return; }
	const dir = tmpDir('esb');
	try {
		const entry = path.join(dir, 'a.ts');
		fs.writeFileSync(entry, 'export const x: number = 1;\n');
		const script = path.join(dir, 'run.cjs');
		fs.writeFileSync(script, `
const esbuild = require(${JSON.stringify(wasmPkg)});
esbuild.build({ entryPoints: [${JSON.stringify(entry)}], outdir: ${JSON.stringify(path.join(dir, 'dist'))},
  platform: 'node', format: 'cjs', logLevel: 'silent' })
  .then(async () => { console.log('BUILD_OK'); await esbuild.stop(); })
  .catch(e => { console.error('BUILD_FAIL', e && e.message || e); process.exit(1); });
`);
		const run = env => {
			const r = spawnSync(NODE, [script], { env, encoding: 'utf8', timeout: 120000 });
			return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
		};
		const bare = run(bareEnv());
		assert.notStrictEqual(bare.code, 0, '裸 PATH 竟然能编译，测试前提不成立');
		assert.match(bare.err + bare.out, /ENOENT|spawn node/, '期望 spawn node ENOENT，实际：' + bare.err);
		const fixed = run(E.withNodeOnPath(bareEnv()));
		assert.strictEqual(fixed.code, 0, '注入 PATH 后编译仍失败：' + fixed.err);
		assert.ok(fixed.out.includes('BUILD_OK'));
		assert.ok(fs.existsSync(path.join(dir, 'dist', 'a.js')));
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('入口脚本都把便携 Node 目录写进 PATH', () => {
	// 干净构建包有 build.bat / build.sh / bootstrap.cjs；原项目只有编译脚本。
	const bootPath = path.join(ROOT, 'bootstrap.cjs');
	const hasKitEntries = fs.existsSync(bootPath);
	if (hasKitEntries) {
		assert.match(fs.readFileSync(path.join(ROOT, 'build.bat'), 'utf8'), /set "PATH=%NODE_DIR%;%PATH%"/);
		assert.match(fs.readFileSync(path.join(ROOT, 'build.sh'), 'utf8'), /export PATH="\$\(dirname "\$NODE_BIN"\):\$PATH"/);
		assert.match(fs.readFileSync(bootPath, 'utf8'), /buildEnv\.applyNodeOnPath/);
	}
	const inst = fs.readFileSync(path.join(ROOT, 'tools', 'build-installer.cjs'), 'utf8');
	assert.match(inst, /buildEnv\.applyNodeOnPath/);
});

/* -------------------------------- 文件占用 -------------------------------- */

t('isTransientFsError：识别占用，但不把只读的 EACCES 当成锁', () => {
	const mk = (code, msg) => Object.assign(new Error(msg || code), { code });
	assert.strictEqual(E.isTransientFsError(mk('EBUSY', 'resource busy or locked, copyfile a -> b')), true);
	assert.strictEqual(E.isTransientFsError(mk('EPERM', 'operation not permitted, rename')), true);
	assert.strictEqual(E.isTransientFsError(mk('ENOENT', 'no such file')), false);
	assert.strictEqual(E.isTransientFsError(mk('EACCES', 'permission denied')), false);
});

t('copyFileResilient：复制二进制内容、自动建目录、内容相同则跳过', () => {
	const dir = tmpDir('copy');
	try {
		const src = path.join(dir, 'src.bin');
		const dest = path.join(dir, 'deep', 'nested', 'out.bin');
		const data = Buffer.from([0, 1, 2, 250, 255, 0, 128]);
		fs.writeFileSync(src, data);
		assert.strictEqual(E.copyFileResilient(src, dest), 'replaced');
		assert.ok(fs.readFileSync(dest).equals(data));
		assert.strictEqual(E.copyFileResilient(src, dest), 'skipped');
		fs.writeFileSync(src, Buffer.from('changed'));
		assert.notStrictEqual(E.copyFileResilient(src, dest), 'skipped');
		assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'changed');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/** 只拦截指定目录下 .tmp 文件的写入，模拟瞬时 / 持久 EBUSY。 */
function withTmpWriteFailures(dir, failFirst, fn) {
	const orig = fs.writeFileSync;
	let hits = 0;
	fs.writeFileSync = function (p, ...rest) {
		if (String(p).startsWith(dir) && String(p).endsWith('.tmp') && hits < failFirst) {
			hits++;
			throw Object.assign(new Error('EBUSY: resource busy or locked, open ' + p), { code: 'EBUSY' });
		}
		return orig.call(this, p, ...rest);
	};
	try { return fn(() => hits); } finally { fs.writeFileSync = orig; }
}

t('copyFileResilient：瞬时 EBUSY 会有限次重试并最终成功', () => {
	const dir = tmpDir('retry');
	try {
		const src = path.join(dir, 'src.txt'), dest = path.join(dir, 'dest.txt');
		fs.writeFileSync(src, 'payload');
		const result = withTmpWriteFailures(dir, 2, () => E.copyFileResilient(src, dest, { attempts: 4, delayMs: 1 }));
		assert.notStrictEqual(result, 'skipped');
		assert.strictEqual(fs.readFileSync(dest, 'utf8'), 'payload');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('copyFileResilient：持久锁不会无限重试，抛出带处置建议的错误', () => {
	const dir = tmpDir('persist');
	try {
		const src = path.join(dir, 'src.txt'), dest = path.join(dir, 'dest.txt');
		fs.writeFileSync(src, 'payload');
		withTmpWriteFailures(dir, 999, getHits => {
			assert.throws(
				() => E.copyFileResilient(src, dest, { attempts: 3, delayMs: 1 }),
				e => /原地重试|全新目录|--out/.test(e.message) && /EBUSY/.test(e.message));
			assert.strictEqual(getHits(), 3, '应恰好尝试 3 次，不能无限重试');
		});
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('copyDirResilient：递归复制 + filter 生效 + 二次复用全部 skipped', () => {
	const dir = tmpDir('dir');
	try {
		const src = path.join(dir, 'src'), dest = path.join(dir, 'dest');
		fs.mkdirSync(path.join(src, 'data'), { recursive: true });
		fs.writeFileSync(path.join(src, 'data', 'a.json'), '{"a":1}');
		fs.writeFileSync(path.join(src, 'data', 'b.txt'), 'skip me');
		fs.writeFileSync(path.join(src, 'root.json'), '{}');
		const filter = rel => rel.endsWith('.json');
		const first = E.copyDirResilient(src, dest, { attempts: 2, delayMs: 1, filter });
		assert.strictEqual(first.copied, 2);
		assert.strictEqual(first.skipped, 0);
		assert.ok(fs.existsSync(path.join(dest, 'data', 'a.json')));
		assert.ok(!fs.existsSync(path.join(dest, 'data', 'b.txt')));
		const again = E.copyDirResilient(src, dest, { attempts: 2, delayMs: 1, filter });
		assert.strictEqual(again.copied, 0);
		assert.strictEqual(again.skipped, 2);
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

t('findLockedFiles：普通目录无锁定；freshOutDir 生成全新路径', () => {
	const dir = tmpDir('lock');
	try {
		fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
		assert.deepStrictEqual(E.findLockedFiles(dir), []);
		assert.deepStrictEqual(E.findLockedFiles(path.join(dir, 'nope')), []);
		assert.strictEqual(E.freshOutDir('release', 1), 'release-retry-1');
		assert.strictEqual(E.freshOutDir('C:/tmp/out/', 2), 'C:/tmp/out-retry-2');
	} finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

/* ------------------------------ 链路接线检查 ------------------------------ */

t('build-engine.cjs 不再使用裸 copyFileSync，并显式停止 esbuild 服务', () => {
	const s = fs.readFileSync(path.join(ROOT, 'tools', 'build-engine.cjs'), 'utf8');
	assert.ok(!/fs\.copyFileSync\s*\(/.test(s), '仍存在裸 fs.copyFileSync 调用');
	assert.match(s, /copyFileResilient/);
	assert.match(s, /esbuild\.stop\(\)/);
	assert.match(s, /installNodeSpawnFallback/);
});

t('打包链路：暂存 extraResources、锁审计、重试上限 3 次与换目录策略', () => {
	const inst = fs.readFileSync(path.join(ROOT, 'tools', 'build-installer.cjs'), 'utf8');
	assert.match(inst, /stageExtraResources/);
	assert.match(inst, /auditOutputLocks/);
	const bootPath = path.join(ROOT, 'bootstrap.cjs');
	if (fs.existsSync(bootPath)) {
		const boot = fs.readFileSync(bootPath, 'utf8');
		assert.match(boot, /MAX_ATTEMPTS = 3/);
		assert.match(boot, /freshOutDir/);
		assert.ok(!/MAX_ATTEMPTS = 5/.test(boot), '不应再原地重试 5 次');
	}
});

t('extraResources 以独立配置文件传入，避免与 package.json 的旧条目 concat 合并', () => {
	const inst = fs.readFileSync(path.join(ROOT, 'tools', 'build-installer.cjs'), 'utf8');
	assert.match(inst, /function writeEffectiveConfig/);
	assert.match(inst, /config: configPath/, 'build() 必须传配置文件路径（字符串）');
	assert.ok(!/builder\.build\(\{\s*config\s*,/.test(inst), '不能把 config 对象直接传给 build()');
	// electron-builder 的 deepAssign 对数组是 concat：传对象时 package.json 里
	// 指向 node_modules/esbuild-wasm 的旧条目仍会执行并再次触发 EBUSY。
	assert.match(inst, /deepAssign/);
	assert.match(inst, /STAGE_ROOT, 'engine'/, '暂存区路径应为绝对路径，避免相对基准歧义');
	// ts-chacha20 若藏在 engine/node_modules 内会被 electron-builder 静默过滤，
	// 必须作为独立的一条 extraResources 打进 engine/node_modules/ts-chacha20。
	assert.match(inst, /to: 'engine\/node_modules\/ts-chacha20'/);
	assert.match(inst, /abs\('ts-chacha20'\)/);
});

t('package.json 把 tools/build-env.cjs 一起打进客户端（build-engine.cjs 需要它）', () => {
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.ok(pkg.build.files.includes('tools/build-env.cjs'));
	assert.ok(pkg.scripts['test:buildenv']);
});

t('outDirFromArgs：识别 -o/--out/--out= 并取最后一个', () => {
	const bootPath = path.join(ROOT, 'bootstrap.cjs');
	if (!fs.existsSync(bootPath)) { console.log('       (跳过：原项目没有 bootstrap.cjs)'); return; }
	const B = require(bootPath);
	assert.strictEqual(B.outDirFromArgs(['--os', 'windows']), 'release');
	assert.strictEqual(B.outDirFromArgs(['-o', 'dist-a']), 'dist-a');
	assert.strictEqual(B.outDirFromArgs(['--out=dist-b', '--out', 'dist-c']), 'dist-c');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
