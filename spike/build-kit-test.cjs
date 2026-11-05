#!/usr/bin/env node
/**
 * 干净构建包回归测试（纯 Node，不联网、不写项目目录）
 *   node spike/build-kit-test.cjs
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const B = require(path.join(ROOT, 'bootstrap.cjs'));

let passed = 0, failed = 0;
function t(name, fn) {
	try { fn(); passed++; console.log('  OK   ' + name); }
	catch (e) { failed++; console.log('  FAIL ' + name + ': ' + e.message); }
}

/* -------------------- 手工构造 tar 块，用于验证解压器 -------------------- */
function tarHeader(name, size, type = '0') {
	const h = Buffer.alloc(512, 0);
	h.write(name.slice(0, 100), 0, 'utf8');
	h.write('0000644\0', 100, 'utf8');
	h.write('0000000\0', 108, 'utf8');
	h.write('0000000\0', 116, 'utf8');
	h.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
	h.write('00000000000\0', 136, 'utf8');
	h.write('        ', 148, 'utf8'); // chksum：本解压器不校验
	h.write(type, 156, 'utf8');
	h.write('ustar\0', 257, 'utf8');
	h.write('00', 263, 'utf8');
	return h;
}
function tarEntry(name, body, type = '0') {
	const data = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
	const head = tarHeader(name, data.length, type);
	const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
	return Buffer.concat([head, data, pad]);
}
function tgz(entries) {
	return zlib.gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));
}

console.log('\n=== 干净构建包回归测试 ===\n');

t('parseArgs：引导参数被消费，构建参数原样透传', () => {
	const o = B.parseArgs(['--ps-ref', 'abc123', '--setup-only', '--os', 'all', '--arch', 'arm64', '--target', 'tar.gz', '--out=dist-x']);
	assert.strictEqual(o.psRef, 'abc123');
	assert.strictEqual(o.setupOnly, true);
	assert.deepStrictEqual(o.forward, ['--os', 'all', '--arch', 'arm64', '--target', 'tar.gz', '--out=dist-x']);
});

t('parseArgs：--no-mirror 同时作用于引导与编译脚本', () => {
	const o = B.parseArgs(['--no-mirror', '-p', 'linux', '-a', 'x64']);
	assert.strictEqual(o.noMirror, true);
	assert.deepStrictEqual(o.forward, ['--no-mirror', '-p', 'linux', '-a', 'x64']);
});

t('parseArgs：--flag=value 形式可解析', () => {
	const o = B.parseArgs(['--npm-registry=https://example.com/npm', '--dry-run']);
	assert.strictEqual(o.npmRegistry, 'https://example.com/npm');
	assert.strictEqual(o.dryRun, true);
	assert.deepStrictEqual(o.forward, []);
});

t('cmpVersion：语义化版本比较', () => {
	assert.ok(B.cmpVersion('22.22.2', '22.18.0') > 0);
	assert.ok(B.cmpVersion('20.1.0', '22.18.0') < 0);
	assert.strictEqual(B.cmpVersion('22.18.0', '22.18.0'), 0);
	assert.ok(B.cmpVersion('24.14.0', '22.18.0') > 0);
});

t('safeJoin：过滤 .. / 绝对路径 / 盘符', () => {
	const root = path.join(os.tmpdir(), 'pbsim-root');
	assert.strictEqual(B.safeJoin(root, 'a/b/c.ts'), path.join(root, 'a', 'b', 'c.ts'));
	assert.strictEqual(B.safeJoin(root, '../../evil'), path.join(root, 'evil'));
	assert.strictEqual(B.safeJoin(root, ''), null);
	assert.strictEqual(B.safeJoin(root, '/etc/passwd'), path.join(root, 'etc', 'passwd'));
});

t('extractTarGz：strip=1 剥掉 GitHub 顶层目录', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-tar-'));
	try {
		const file = path.join(tmp, 'src.tar.gz');
		fs.writeFileSync(file, tgz([
			tarEntry('pokemon-showdown-master/', '', '5'),
			tarEntry('pokemon-showdown-master/package.json', '{"name":"pokemon-showdown"}'),
			tarEntry('pokemon-showdown-master/sim/index.ts', 'export const x = 1;'),
			tarEntry('pokemon-showdown-master/data/pokedex.ts', 'export const dex = {};'),
		]));
		const dest = path.join(tmp, 'out');
		const n = B.extractTarGz(file, dest, 1);
		assert.strictEqual(n, 3);
		assert.ok(fs.existsSync(path.join(dest, 'package.json')));
		assert.ok(fs.existsSync(path.join(dest, 'sim/index.ts')));
		assert.ok(fs.existsSync(path.join(dest, 'data/pokedex.ts')));
		assert.ok(!fs.existsSync(path.join(dest, 'pokemon-showdown-master')));
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('extractTarGz：GNU longname 与 PAX path 都能还原长路径', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-tar-'));
	try {
		const long = 'pokemon-showdown-master/data/mods/' + 'x'.repeat(90) + '/scripts.ts';
		const paxPath = 'pokemon-showdown-master/data/text/zh-cn/pokedex.ts';
		const paxBody = `36 path=${paxPath}\n`;
		const file = path.join(tmp, 'src.tar.gz');
		fs.writeFileSync(file, tgz([
			tarEntry('LongLink', Buffer.from(long + '\0'), 'L'),
			tarEntry('pokemon-showdown-master/data/mod', 'export const a = 1;'),
			tarEntry('PaxHeaders/0', Buffer.from(paxBody), 'x'),
			tarEntry('pokemon-showdown-master/data/truncated', 'export const b = 2;'),
		]));
		const dest = path.join(tmp, 'out');
		B.extractTarGz(file, dest, 1);
		assert.ok(fs.existsSync(path.join(dest, long.replace(/^pokemon-showdown-master\//, ''))), 'GNU longname 未还原');
		assert.ok(fs.existsSync(path.join(dest, 'data/text/zh-cn/pokedex.ts')), 'PAX path 未还原');
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('extractTarGz：拒绝路径穿越与符号链接', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-tar-'));
	try {
		const file = path.join(tmp, 'bad.tar.gz');
		fs.writeFileSync(file, tgz([
			tarEntry('repo/../../evil.ts', 'pwned'),
			tarEntry('repo/link.ts', 'evil.ts', '2'),
			tarEntry('repo/ok.ts', 'fine'),
		]));
		const dest = path.join(tmp, 'out');
		const n = B.extractTarGz(file, dest, 1);
		assert.strictEqual(n, 1, '应只写出 1 个普通文件（穿越条目与符号链接都被丢弃）');
		assert.ok(fs.existsSync(path.join(dest, 'ok.ts')));
		assert.ok(!fs.existsSync(path.join(dest, 'evil.ts')));
		assert.ok(!fs.existsSync(path.join(tmp, 'evil.ts')));
		assert.ok(!fs.existsSync(path.join(dest, 'link.ts')));
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('extractTarGz：空包报错', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-tar-'));
	try {
		const file = path.join(tmp, 'empty.tar.gz');
		fs.writeFileSync(file, tgz([]));
		assert.throws(() => B.extractTarGz(file, path.join(tmp, 'out'), 1), /为空/);
	} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

t('配置文件齐全且有效', () => {
	const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'build-kit.json'), 'utf8'));
	assert.ok(/^https:\/\//.test(cfg.npmRegistry));
	assert.strictEqual(cfg.pokemonShowdown.repo, 'smogon/pokemon-showdown');
	assert.ok(cfg.pokemonShowdown.ref);
	const ver = fs.readFileSync(path.join(ROOT, '.node-version'), 'utf8').trim();
	assert.match(ver, /^\d+\.\d+\.\d+$/);
	const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
	assert.strictEqual(pkg.scripts['dist:all'], 'node bootstrap.cjs --os all --arch all');
	assert.strictEqual(pkg.scripts['kit:setup'], 'node bootstrap.cjs --setup-only');
});

t('.gitignore 声明了全部「运行时下载/生成」目录', () => {
	const gi = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
	for (const d of ['.runtime/', 'node_modules/', 'pokemon-showdown-master/', '.cache/', 'build/', 'release/']) {
		assert.ok(gi.includes(d), '缺少 ' + d);
	}
});

t('入口文件齐全', () => {
	for (const f of ['bootstrap.cjs', 'build.bat', 'build.sh', 'README.md', 'tools/build-installer.cjs', 'tools/build-engine.cjs', 'tools/make-icon.cjs', 'package-lock.json']) {
		assert.ok(fs.existsSync(path.join(ROOT, f)), '缺少 ' + f);
	}
});

t('findNpmCli 在当前 Node 安装下可用', () => {
	assert.ok(B.findNpmCli(), '找不到 npm-cli.js');
});

console.log(`\n结果: ${passed} 通过 / ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
