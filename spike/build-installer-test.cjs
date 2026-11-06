#!/usr/bin/env node
/**
 * build-installer.cjs 回归测试（不联网、不打包，纯逻辑层）
 * 运行: node spike/build-installer-test.cjs
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const B = require('../tools/build-installer.cjs');
const PKG = JSON.parse(fs.readFileSync(path.join(B.ROOT, 'package.json'), 'utf8'));

let passed = 0;
function t(name, fn) {
	try { fn(); passed++; console.log('  ok  ' + name); }
	catch (e) { console.error('  FAIL  ' + name + '\n        ' + (e && e.message)); process.exitCode = 1; }
}

function makeTgz(entries) {
	const blocks = [];
	for (const e of entries) {
		const h = Buffer.alloc(512);
		const size = e.type === '5' ? 0 : e.data.length;
		h.write(e.name, 0, 100, 'utf8');
		h.write('0000644\0', 100, 8, 'ascii');
		h.write('0000000\0', 108, 8, 'ascii');
		h.write('0000000\0', 116, 8, 'ascii');
		h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
		h.write('00000000000\0', 136, 12, 'ascii');
		h.fill(0x20, 148, 156);
		h[156] = e.type === '5' ? 53 : 48;
		h.write('ustar\0', 257, 6, 'ascii');
		h.write('00', 263, 2, 'ascii');
		let sum = 0;
		for (const byte of h) sum += byte;
		h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
		blocks.push(h);
		if (e.type !== '5') {
			blocks.push(e.data);
			const pad = Math.ceil(size / 512) * 512 - size;
			if (pad) blocks.push(Buffer.alloc(pad));
		}
	}
	blocks.push(Buffer.alloc(1024));
	return zlib.gzipSync(Buffer.concat(blocks));
}

console.log('build-installer.cjs 回归测试\n');

t('默认参数取宿主平台与架构', () => {
	const o = B.parseArgs([]);
	assert.strictEqual(o.os[0], B.HOST_OS === 'mac' ? 'linux' : B.HOST_OS);
	assert.strictEqual(o.arch[0], B.HOST_ARCH);
	assert.strictEqual(o.out, 'release');
	assert.strictEqual(o.mirror, true);
	assert.strictEqual(o.dryRun, false);
});

t('长参数 / 等号 / 别名 / 逗号列表', () => {
	const o = B.parseArgs(['-p', 'win,linux', '--arch=arm64,x64', '--target', 'nsis', '--no-mirror', '-o', 'dist-all']);
	assert.deepStrictEqual(o.os, ['windows', 'linux']);
	assert.deepStrictEqual(o.arch, ['x64', 'arm64']);
	assert.deepStrictEqual(o.targets, ['nsis']);
	assert.strictEqual(o.mirror, false);
	assert.strictEqual(o.out, 'dist-all');
});

t('all 展开为 2 个平台 / 2 个架构', () => {
	const o = B.parseArgs(['--os', 'all', '-a', 'all']);
	assert.deepStrictEqual(o.os, ['windows', 'linux']);
	assert.deepStrictEqual(o.arch, ['x64', 'arm64']);
});

t('--dir 覆盖 --target', () => {
	const o = B.parseArgs(['--target', 'nsis,portable', '--dir']);
	assert.deepStrictEqual(o.targets, ['dir']);
});

t('--help 不报错', () => {
	assert.strictEqual(B.parseArgs(['--help']).help, true);
});

t('非法 OS / arch / target / 未知参数均报错', () => {
	assert.throws(() => B.parseArgs(['--os', 'solaris']), /不支持/);
	assert.throws(() => B.parseArgs(['--arch', 'mips']), /不支持/);
	assert.throws(() => B.parseArgs(['--target', 'nope']), /不支持/);
	assert.throws(() => B.parseArgs(['--wat']), /未知参数/);
});

t('参数缺值报错', () => {
	assert.throws(() => B.parseArgs(['--os']), /缺少参数值/);
});

t('目标类型与平台匹配', () => {
	B.validateTargets('windows', ['nsis', 'portable', 'dir']);
	B.validateTargets('linux', ['tar.gz', 'deb', 'appimage', 'dir']);
	assert.throws(() => B.validateTargets('windows', ['deb']), /不适用于 windows/);
	assert.throws(() => B.validateTargets('linux', ['nsis']), /不适用于 linux/);
});

t('默认产物：Windows→nsis+portable，Windows 主机 Linux→tar.gz，Linux 主机 Linux→deb+appimage+tar.gz', () => {
	assert.deepStrictEqual(B.defaultTargets('windows'), ['nsis', 'portable']);
	assert.deepStrictEqual(B.defaultTargets('linux'), B.IS_WINDOWS_HOST ? ['tar.gz'] : ['deb', 'appimage', 'tar.gz']);
	assert.deepStrictEqual(B.defaultTargets('linux', 'win32'), ['tar.gz']);
	assert.deepStrictEqual(B.defaultTargets('linux', 'linux'), ['deb', 'appimage', 'tar.gz']);
	assert.deepStrictEqual(B.defaultTargets('windows', 'linux'), ['nsis', 'portable']);
});

t('buildConfig 注入目标架构、target 与输出目录且不改 package.json', () => {
	const before = JSON.stringify(PKG.build);
	for (const osName of ['windows', 'linux']) {
		const cfg = B.buildConfig(PKG, osName, 'arm64', ['dir'], 'C:/tmp/pbsim-out');
		assert.strictEqual(cfg.directories.output, 'C:/tmp/pbsim-out');
		const shaped = cfg[osName === 'windows' ? 'win' : 'linux'].target;
		assert.strictEqual(shaped.length, 1);
		assert.deepStrictEqual(shaped[0], { target: 'dir', arch: ['arm64'] });
		assert.strictEqual(cfg.asar, false);
		assert.ok(cfg.extraResources.some(r => String(r.to).includes('engine')));
	}
	assert.strictEqual(JSON.stringify(PKG.build), before, 'package.json 的 build 配置被意外修改');
});

t('Linux 配置带图标/分类/带架构的制品名', () => {
	const cfg = B.buildConfig(PKG, 'linux', 'x64', ['tar.gz'], 'release');
	assert.strictEqual(cfg.linux.icon, 'build/icon.png');
	assert.strictEqual(cfg.linux.category, 'Game');
	assert.ok(cfg.linux.artifactName.includes('${arch}'));
});

t('extractTgz 解包并挡住路径穿越', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-tgz-'));
	try {
		const gz = makeTgz([
			{ name: 'package/', type: '5' },
			{ name: 'package/package.json', data: Buffer.from('{"name":"demo"}') },
			{ name: 'package/index.js', data: Buffer.from('module.exports = 42;') },
			{ name: 'package/../evil.txt', data: Buffer.from('should not escape') },
			{ name: 'package/data/', type: '5' },
			{ name: 'package/data/a.json', data: Buffer.from('{"a":1}') },
		]);
		const dest = path.join(tmp, 'pkg');
		const count = B.extractTgz(gz, dest);
		assert.ok(count >= 3, '至少解出 3 个文件');
		assert.strictEqual(fs.readFileSync(path.join(dest, 'index.js'), 'utf8'), 'module.exports = 42;');
		assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dest, 'data/a.json'), 'utf8')).a, 1);
		assert.ok(!fs.existsSync(path.join(tmp, 'evil.txt')), '路径穿越未被拦截');
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

t('prepareEnv 设置镜像、关闭签名发现、清掉 ELECTRON_RUN_AS_NODE', () => {
	const saved = { ...process.env };
	try {
		delete process.env.ELECTRON_MIRROR;
		delete process.env.ELECTRON_BUILDER_BINARIES_MIRROR;
		delete process.env.CSC_IDENTITY_AUTO_DISCOVERY;
		process.env.ELECTRON_RUN_AS_NODE = '1';
		B.prepareEnv({ mirror: true, electronMirror: null });
		assert.ok(process.env.ELECTRON_MIRROR.includes('npmmirror'));
		assert.ok(process.env.ELECTRON_BUILDER_BINARIES_MIRROR.includes('npmmirror'));
		assert.strictEqual(process.env.CSC_IDENTITY_AUTO_DISCOVERY, 'false');
		assert.ok(!('ELECTRON_RUN_AS_NODE' in process.env));
		delete process.env.ELECTRON_MIRROR;
		B.prepareEnv({ mirror: true, electronMirror: 'https://example.com/electron/' });
		assert.strictEqual(process.env.ELECTRON_MIRROR, 'https://example.com/electron/');
	} finally {
		for (const k of ['ELECTRON_MIRROR', 'ELECTRON_BUILDER_BINARIES_MIRROR', 'CSC_IDENTITY_AUTO_DISCOVERY', 'ELECTRON_RUN_AS_NODE']) delete process.env[k];
		Object.assign(process.env, saved);
	}
});

t('collectArtifacts 只列顶层制品与免安装目录主程序', () => {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-out-'));
	try {
		const since = Date.now() - 1000;
		fs.writeFileSync(path.join(tmp, 'app-1.0-x64.exe'), 'exe');
		fs.writeFileSync(path.join(tmp, 'old-1.0-arm64.exe'), 'old');
		fs.writeFileSync(path.join(tmp, 'builder-debug.yml'), 'debug');
		fs.mkdirSync(path.join(tmp, 'win-unpacked'));
		fs.writeFileSync(path.join(tmp, 'win-unpacked', 'PokemonBattleSim.exe'), 'exe');
		fs.writeFileSync(path.join(tmp, 'win-unpacked', 'ffmpeg.dll'), 'dll');
		const found = B.collectArtifacts(tmp, since);
		const names = found.map(f => f.file);
		assert.ok(names.includes('app-1.0-x64.exe'));
		assert.ok(names.includes('win-unpacked/PokemonBattleSim.exe'));
		assert.ok(!names.includes('builder-debug.yml'));
		assert.ok(!names.some(n => n.endsWith('ffmpeg.dll')));

		// 真实构建路径：以 builder 返回的制品为准，不混入其它组合的旧文件
		const precise = B.collectArtifacts(
			tmp, since, [path.join(tmp, 'app-1.0-x64.exe')], 'win-unpacked');
		const preciseNames = precise.map(f => f.file);
		assert.deepStrictEqual(preciseNames.sort(), ['app-1.0-x64.exe', 'win-unpacked/PokemonBattleSim.exe']);
		assert.ok(!preciseNames.includes('old-1.0-arm64.exe'));
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true });
	}
});

t('npm scripts 暴露统一入口', () => {
	// 干净构建包通过 bootstrap.cjs 转发（会先补齐依赖与源码），原项目直接调编译脚本。
	assert.match(PKG.scripts['build:installer'], /bootstrap\.cjs|build-installer\.cjs/);
	assert.match(PKG.scripts['dist:all'], /--os all --arch all/);
});

console.log(`\n通过 ${passed} 项。`);
