#!/usr/bin/env node
/**
 * 宝可梦对战沙盘 · 构建包引导脚本
 * =====================================================================
 * 这个文件夹只包含「项目自研源码 + 构建脚本」。凡是能联网取得的内容，
 * 都不随包分发，而是由本脚本在运行时按需下载/生成：
 *
 *   1. Node.js 便携运行时      -> .runtime/node/        （无可用 Node 时由 build.bat / build.sh 下载）
 *   2. npm 开发依赖            -> node_modules/         （npm install，含 electron-builder / esbuild-wasm）
 *   3. Pokemon Showdown 源码   -> pokemon-showdown-master/ （GitHub codeload tarball）
 *   4. 引擎编译产物 dist       -> 由 tools/build-engine.cjs 生成
 *   5. ts-chacha20 / 图标      -> 由 tools/build-installer.cjs 自动补齐/生成
 *   6. Electron / NSIS / 7z    -> 由 electron-builder 自行下载到系统缓存
 *
 * 准备完成后，本脚本把其余参数原样透传给 tools/build-installer.cjs，
 * 由它真正产出 windows/linux × x64/arm64 安装包。
 *
 * 用法见 README.md 或 --help。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawn, spawnSync } = require('child_process');

const ROOT = __dirname;
const ENGINE_DIR = path.join(ROOT, 'pokemon-showdown-master');
const CACHE_DIR = path.join(ROOT, '.cache');
const RUNTIME_DIR = path.join(ROOT, '.runtime');
const KIT_CONFIG = path.join(ROOT, 'build-kit.json');
const PKG = path.join(ROOT, 'package.json');

const DEFAULTS = {
	nodeVersion: '22.22.2',
	npmRegistry: 'https://registry.npmmirror.com',
	npmRegistryOfficial: 'https://registry.npmjs.org',
	psRepo: 'smogon/pokemon-showdown',
	psRef: 'master',
	githubApi: 'https://api.github.com',
	codeload: 'https://codeload.github.com',
};

const HELP = `
宝可梦对战沙盘 · 构建包引导脚本
============================================================
用法: build.bat [选项]        (Windows)
      ./build.sh [选项]       (Linux / macOS)
      node bootstrap.cjs [选项]

引导脚本专有参数（其余参数原样传给 tools/build-installer.cjs）:
      --ps-ref <ref>        指定 Pokemon Showdown 的分支/标签/提交 sha
                            默认 master（可改 build-kit.json）
      --npm-registry <url>  自定义 npm registry
      --force-engine        强制重新下载 Pokemon Showdown 源码
      --force-deps          强制重新 npm install
      --setup-only          只准备依赖，不执行打包
      --no-mirror           不使用国内镜像（npm / electron 均走官方源）
      --dry-run             只打印本次会下载/执行的计划，不写文件
  -h, --help                显示本帮助

透传给编译脚本的常用参数:
  -p, --os <windows|linux|all>     目标系统，默认当前系统
  -a, --arch <x64|arm64|all>       目标架构，默认当前架构
  -t, --target <list>              产物类型，如 nsis,portable / tar.gz / deb,appimage
      --dir                        只产免安装目录（最快）
  -o, --out <dir>                  输出目录，默认 release
      --clean / --rebuild-engine / --skip-engine
      --electron-mirror <url>

示例:
  build.bat --os windows --arch x64
  build.bat --os all --arch all
  build.bat --setup-only
  ./build.sh --os linux --arch arm64
  node bootstrap.cjs --dry-run --os all --arch all

环境变量:
  PBSIM_NODE              指定用于引导的 node 可执行文件
  PBSIM_NODE_VERSION      覆盖便携 Node 版本（默认读 .node-version）
  PBSIM_FORCE_NODE=1      强制 build.bat / build.sh 下载便携 Node（用于验证）
`;

/* ------------------------------- 基础工具 ------------------------------- */

function step(msg) { console.log(`\n==> ${msg}`); }
function ok(msg) { console.log(`    ${msg}`); }
function warn(msg) { console.log(`    ! ${msg}`); }
function fail(msg) { throw new Error(msg); }
function mb(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function readJson(file, fallback) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch { return fallback; }
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function safeJoin(root, rel) {
	const parts = rel.replace(/\\/g, '/').split('/').filter(x => x && x !== '.' && x !== '..');
	if (!parts.length) return null;
	return path.join(root, ...parts);
}

/** 带重定向、超时与进度的 HTTPS GET，返回 Buffer。 */
function request(url, opts = {}, redirects = 0) {
	return new Promise((resolve, reject) => {
		if (redirects > 6) return reject(new Error('重定向次数过多'));
		const req = https.get(url, {
			timeout: 60000,
			headers: { 'User-Agent': 'PokemonBattleSim-BuildKit', Accept: '*/*' },
		}, res => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				return resolve(request(new URL(res.headers.location, url).toString(), opts, redirects + 1));
			}
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
			}
			const total = Number(res.headers['content-length']) || 0;
			const chunks = [];
			let received = 0, lastPct = -1;
			res.on('data', d => {
				chunks.push(d);
				received += d.length;
				if (opts.onProgress && total) {
					const pct = Math.floor(received / total * 20);
					if (pct !== lastPct) { lastPct = pct; opts.onProgress(received, total); }
				}
			});
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.on('timeout', () => req.destroy(new Error(`请求超时: ${url}`)));
	});
}

async function downloadTo(url, file, label) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const buf = await request(url, {
		onProgress: (got, total) => {
			process.stdout.write(`\r    ${label}: ${mb(got)} / ${mb(total)}`);
		},
	});
	process.stdout.write('\n');
	fs.writeFileSync(file, buf);
	return buf.length;
}

/**
 * 极简 tar.gz 解压，支持 USTAR / GNU longname / PAX path，默认剥掉第一层目录
 * （GitHub codeload 包形如 pokemon-showdown-master/...）。
 * 过滤 .. 与盘符路径，跳过符号链接，不依赖系统 tar 或第三方模块。
 */
function extractTarGz(tgzFile, destDir, strip = 1) {
	const buf = zlib.gunzipSync(fs.readFileSync(tgzFile));
	let off = 0, longName = null, files = 0;
	while (off + 512 <= buf.length) {
		const head = buf.subarray(off, off + 512);
		off += 512;
		if (head.every(b => b === 0)) break;
		const readStr = (start, len) => head.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '').trim();
		let name = readStr(0, 100);
		const prefix = readStr(345, 500);
		if (prefix) name = `${prefix}/${name}`;
		const size = parseInt(readStr(124, 12), 8) || 0;
		const type = String.fromCharCode(head[156] || 48);
		const body = buf.subarray(off, off + size);
		off += Math.ceil(size / 512) * 512;

		if (type === 'L') {
			longName = body.toString('utf8').replace(/\0[\s\S]*$/, '').replace(/\r?\n$/, '');
			continue;
		}
		if (type === 'x' || type === 'g') {
			const m = /path=([^\n]+)/.exec(body.toString('utf8'));
			longName = m ? m[1] : null;
			continue;
		}
		if (longName) { name = longName; longName = null; }
		if (!name) continue;

		let rel = name.replace(/\\/g, '/');
		if (strip > 0) rel = rel.split('/').slice(strip).join('/');
		if (!rel || /^[A-Za-z]:/.test(rel)) continue;
		if (rel.split('/').includes('..')) continue; // 直接丢弃穿越条目，不做「净化后仍写入」
		const target = safeJoin(destDir, rel);
		if (!target) continue;
		if (type === '5') { fs.mkdirSync(target, { recursive: true }); continue; }
		if (type !== '0' && type !== '\0' && type !== '7') continue;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, body);
		files++;
	}
	if (!files) fail('源码包解压结果为空');
	return files;
}

/* ------------------------------- 参数解析 ------------------------------- */

function parseArgs(argv) {
	const o = {
		setupOnly: false, dryRun: false, forceEngine: false, forceDeps: false,
		noMirror: false, help: false, psRef: null, npmRegistry: null,
		bootstrapChild: false, forward: [],
	};
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i];
		const eq = raw.indexOf('=');
		const flag = eq > 0 ? raw.slice(0, eq) : raw;
		const inline = eq > 0 ? raw.slice(eq + 1) : null;
		const value = () => inline !== null ? inline : argv[++i];
		switch (flag) {
			case '-h': case '--help': o.help = true; break;
			case '--setup-only': o.setupOnly = true; break;
			case '--dry-run': o.dryRun = true; break;
			case '--force-engine': o.forceEngine = true; break;
			case '--force-deps': o.forceDeps = true; break;
			case '--no-mirror': o.noMirror = true; o.forward.push(raw); break;
			case '--ps-ref': o.psRef = value(); break;
			case '--npm-registry': o.npmRegistry = value(); break;
			case '--bootstrap-child': o.bootstrapChild = true; break;
			default: o.forward.push(raw); break;
		}
	}
	return o;
}

/* ------------------------------ Node 运行时 ------------------------------ */

function cmpVersion(have, want) {
	const a = String(have).split('.').map(Number);
	const b = String(want).split('.').map(Number);
	for (let i = 0; i < 3; i++) {
		const d = (a[i] || 0) - (b[i] || 0);
		if (d !== 0) return d;
	}
	return 0;
}

function localRuntimeNode() {
	const cands = process.platform === 'win32'
		? [path.join(RUNTIME_DIR, 'node', 'node.exe')]
		: [path.join(RUNTIME_DIR, 'node', 'bin', 'node')];
	return cands.find(f => fs.existsSync(f)) || null;
}

function ensureNodeVersion(o, minNode) {
	if (cmpVersion(process.versions.node, minNode) >= 0) return;
	const local = localRuntimeNode();
	if (local && !o.bootstrapChild) {
		step(`系统 Node v${process.versions.node} 低于要求 v${minNode}，切换到便携 Node`);
		const r = spawnSync(local, [__filename, ...process.argv.slice(2), '--bootstrap-child'], {
			cwd: ROOT, stdio: 'inherit', env: process.env,
		});
		process.exit(r.status === null ? 1 : r.status);
	}
	fail(`Node.js 版本过低：v${process.versions.node}，需要 >= v${minNode}。请先运行 build.bat / build.sh（会自动下载便携 Node），或设置 PBSIM_NODE 指向新版本 node.exe`);
}

/* ------------------------------- npm 依赖 ------------------------------- */

function depsReady() {
	return fs.existsSync(path.join(ROOT, 'node_modules/electron-builder/out/index.js')) &&
		fs.existsSync(path.join(ROOT, 'node_modules/esbuild-wasm/esbuild.wasm'));
}

function findNpmCli() {
	const d = path.dirname(process.execPath);
	const candidates = [
		path.join(d, 'node_modules/npm/bin/npm-cli.js'),
		path.join(d, '../lib/node_modules/npm/bin/npm-cli.js'),
		path.join(d, '../node_modules/npm/bin/npm-cli.js'),
	];
	return candidates.find(f => fs.existsSync(f)) || null;
}

function ensureDeps(o, registry) {
	if (depsReady() && !o.forceDeps) {
		ok('npm 开发依赖已就绪，跳过安装');
		return;
	}
	const npmCli = findNpmCli();
	if (!npmCli) fail('找不到 npm-cli.js：请用官方 Node.js 发行版运行，或设置 PBSIM_NODE');
	step('安装 npm 开发依赖（electron / electron-builder / esbuild-wasm / jsdom）');
	ok(`registry: ${registry}`);
	const args = [npmCli, 'install', '--no-audit', '--no-fund', '--loglevel=warn', '--replace-registry-host=always'];
	if (registry) args.push(`--registry=${registry}`);
	const env = {
		...process.env,
		ELECTRON_SKIP_BINARY_DOWNLOAD: '1', // Electron 二进制交给 electron-builder 按目标架构下载
		npm_config_fund: 'false',
		npm_config_audit: 'false',
	};
	if (registry) env.npm_config_registry = registry;
	delete env.ELECTRON_RUN_AS_NODE;
	const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env });
	if (r.error) throw r.error;
	if (r.status !== 0) fail(`npm install 失败（退出码 ${r.status}）`);
	if (!depsReady()) fail('npm install 结束，但关键依赖仍缺失，请查看上方日志');
	ok('依赖安装完成');
}

/* --------------------------- Pokemon Showdown 源码 --------------------------- */

function engineReady() {
	for (const rel of ['package.json', 'tsconfig.json', 'config/config-example.js', 'sim', 'data']) {
		if (!fs.existsSync(path.join(ENGINE_DIR, rel))) return false;
	}
	return true;
}

async function ensureEngineSource(o, cfg, psRepo, psRef) {
	if (engineReady() && !o.forceEngine) {
		const meta = readJson(path.join(CACHE_DIR, 'engine-source.json'), null);
		ok(`Pokemon Showdown 源码已就绪${meta && meta.sha ? `（${String(meta.sha).slice(0, 7)}）` : ''}`);
		return;
	}
	step('从 GitHub 下载 Pokemon Showdown 引擎与数据源码');
	let sha = psRef, date = null;
	try {
		const api = `${cfg.githubApi}/repos/${psRepo}/commits/${encodeURIComponent(psRef)}`;
		const j = JSON.parse((await request(api)).toString('utf8'));
		if (j && j.sha) { sha = j.sha; date = j.commit && j.commit.committer && j.commit.committer.date || null; }
	} catch (e) {
		warn(`GitHub API 查询失败（${e.message}），改用 ref 直接下载`);
	}
	const url = `${cfg.codeload}/${psRepo}/tar.gz/${sha}`;
	ok(`仓库: ${psRepo}  ref: ${psRef}  sha: ${sha}`);
	ok(`地址: ${url}`);
	const tgz = path.join(CACHE_DIR, 'pokemon-showdown.tar.gz');
	await downloadTo(url, tgz, '下载源码');

	const staging = path.join(CACHE_DIR, 'ps-staging');
	fs.rmSync(staging, { recursive: true, force: true });
	fs.mkdirSync(staging, { recursive: true });
	const count = extractTarGz(tgz, staging, 1);
	ok(`解压 ${count} 个文件`);
	for (const rel of ['package.json', 'tsconfig.json', 'config/config-example.js', 'sim', 'data', 'data/text/zh-cn']) {
		if (!fs.existsSync(path.join(staging, rel))) fail(`源码包缺少 ${rel}（上游结构可能已变化，可用 --ps-ref 固定版本）`);
	}
	if (fs.existsSync(ENGINE_DIR)) {
		warn('移除不完整的旧引擎目录（其中只有下载/生成的内容）');
		fs.rmSync(ENGINE_DIR, { recursive: true, force: true });
	}
	fs.renameSync(staging, ENGINE_DIR);
	writeJson(path.join(CACHE_DIR, 'engine-source.json'), {
		repo: psRepo, ref: psRef, sha, date, downloadedAt: new Date().toISOString(), files: count,
	});
	ok(`引擎源码就绪: ${ENGINE_DIR}`);
}

/* --------------------------------- 图标 --------------------------------- */

function ensureIcons() {
	if (fs.existsSync(path.join(ROOT, 'build/icon.ico')) && fs.existsSync(path.join(ROOT, 'build/icon.png'))) {
		ok('应用图标已就绪');
		return;
	}
	step('生成应用图标（纯 Node，无图片依赖）');
	const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/make-icon.cjs')], {
		cwd: ROOT, stdio: 'inherit', env: process.env,
	});
	if (r.status !== 0) fail('图标生成失败');
}

/**
 * 实时回显编译脚本输出，同时保留尾部日志用于判断失败类型。
 * Windows 上刚编译出来的 dist 文件可能被杀毒软件/索引服务短暂占用，
 * electron-builder 拷贝 extraResources 时会抛 EBUSY，这类错误重试即可。
 */
function runNodeCapture(script, args) {
	return new Promise((resolve, reject) => {
		const proc = spawn(process.execPath, [script, ...args], {
			cwd: ROOT, env: process.env, stdio: ['inherit', 'pipe', 'pipe'],
		});
		let tail = '';
		const onData = d => {
			const s = d.toString();
			process.stdout.write(s);
			tail = (tail + s).slice(-12000);
		};
		proc.stdout.on('data', onData);
		proc.stderr.on('data', onData);
		proc.on('error', reject);
		proc.on('close', code => resolve({ code, tail }));
	});
}

const TRANSIENT_FS_ERROR = /EBUSY|EPERM|resource busy or locked|os error 32|operation did not complete/i;

/**
 * 提前编译引擎 dist：这样进入 electron-builder 的拷贝阶段时，
 * dist 文件已经「冷」下来，不会被 Windows 的杀毒/索引服务短暂锁定。
 * 若用户传了 --rebuild-engine，编译脚本仍会再编译一次。
 */
async function ensureEngineDist() {
	const entry = path.join(ENGINE_DIR, 'dist', 'sim', 'index.js');
	if (fs.existsSync(entry)) { ok('引擎 dist 已存在'); return; }
	step('编译 Pokemon Showdown 引擎 dist（esbuild-wasm，约 1-3 分钟）');
	const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/build-engine.cjs'), ENGINE_DIR], {
		cwd: ROOT, stdio: 'inherit', env: process.env,
	});
	if (r.error) throw r.error;
	if (r.status !== 0) fail('引擎编译失败');
	if (!fs.existsSync(entry)) fail('引擎编译后仍缺少 dist/sim/index.js');
	ok('编译完成，等待 3 秒让文件系统释放新生成的文件');
	await sleep(3000);
}

async function runBuildInstaller(args) {
	const script = path.join(ROOT, 'tools/build-installer.cjs');
	const MAX_ATTEMPTS = 5;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		step(attempt === 1
			? '调用 tools/build-installer.cjs 生成安装包'
			: `重试打包（第 ${attempt - 1} 次，上一次是瞬时文件占用）`);
		const { code, tail } = await runNodeCapture(script, args);
		if (code === 0) return;
		if (attempt < MAX_ATTEMPTS && TRANSIENT_FS_ERROR.test(tail)) {
			warn(`检测到 Windows 瞬时文件占用，等待 ${attempt * 3} 秒后重试（${attempt}/${MAX_ATTEMPTS - 1}）`);
			await sleep(attempt * 3000);
			continue;
		}
		fail(`构建失败（退出码 ${code}）`);
	}
}

/* -------------------------------- 主流程 -------------------------------- */

function printHeader(o, cfg, minNode, psRepo, psRef, registry) {
	console.log('\n========================================');
	console.log(' 宝可梦对战沙盘 · 干净构建包');
	console.log('========================================');
	console.log(` 目录:     ${ROOT}`);
	console.log(` Node:     v${process.versions.node}（要求 >= v${minNode}）`);
	console.log(` npm 源:   ${registry}`);
	console.log(` 引擎源:   ${psRepo} @ ${psRef}`);
	console.log(` 构建参数: ${o.forward.join(' ') || '(默认：当前系统 / 当前架构)'}`);
	ok(`配置文件: ${path.relative(ROOT, KIT_CONFIG)}`);
}

async function main() {
	const o = parseArgs(process.argv.slice(2));
	if (o.help) { console.log(HELP); return; }

	// 宿主注入的 ELECTRON_RUN_AS_NODE 会让 electron-builder 误判，整个链路里清掉。
	delete process.env.ELECTRON_RUN_AS_NODE;

	const pkg = readJson(PKG, {});
	const minNode = ((pkg.engines && pkg.engines.node) || '>=22.18.0').match(/(\d+)\.(\d+)\.(\d+)/);
	const minNodeStr = minNode ? `${minNode[1]}.${minNode[2]}.${minNode[3]}` : DEFAULTS.nodeVersion;
	ensureNodeVersion(o, minNodeStr);

	const fileCfg = readJson(KIT_CONFIG, {});
	const cfg = {
		npmRegistry: DEFAULTS.npmRegistry,
		npmRegistryOfficial: DEFAULTS.npmRegistryOfficial,
		githubApi: DEFAULTS.githubApi,
		codeload: DEFAULTS.codeload,
		...(fileCfg || {}),
	};
	const ps = fileCfg.pokemonShowdown || {};
	const psRepo = ps.repo || DEFAULTS.psRepo;
	const psRef = o.psRef || ps.ref || DEFAULTS.psRef;
	const registry = o.npmRegistry || (o.noMirror ? cfg.npmRegistryOfficial : cfg.npmRegistry);

	printHeader(o, cfg, minNodeStr, psRepo, psRef, registry);

	const meta = readJson(path.join(CACHE_DIR, 'engine-source.json'), null);
	const plan = [
		['便携 Node 运行时', localRuntimeNode() ? `.runtime/node/（已存在）` : '无需下载（使用系统 Node）'],
		['npm 开发依赖', depsReady() && !o.forceDeps ? '已存在，跳过' : `npm install → node_modules/（${registry}）`],
		['Pokemon Showdown', engineReady() && !o.forceEngine ? `已存在${meta && meta.sha ? `（${String(meta.sha).slice(0, 7)}）` : ''}，跳过` : `下载 ${psRepo} @ ${psRef} → pokemon-showdown-master/`],
		['引擎 dist / ts-chacha20 / 图标', '由引导脚本编译 dist，编译脚本补齐 ts-chacha20 与图标'],
		['打包', o.setupOnly ? '跳过（--setup-only）' : `tools/build-installer.cjs ${o.forward.join(' ')}`],
	];
	step('本次计划');
	for (const [k, v] of plan) ok(`${k.padEnd(24)} ${v}`);
	if (o.dryRun) { ok('\n（dry-run）未下载、未写入任何内容。'); return; }

	ensureDeps(o, registry);
	await ensureEngineSource(o, cfg, psRepo, psRef);
	ensureIcons();
	if (!o.dryRun) await ensureEngineDist();

	if (o.setupOnly) {
		step('依赖准备完成（--setup-only）');
		ok('现在可直接执行：node tools/build-installer.cjs --os all --arch all');
		return;
	}

	await runBuildInstaller(o.forward);
	console.log('\n完成。产物位于 release/（或 --out 指定目录）。\n');
}

if (require.main === module) {
	main().catch(err => {
		console.error('\n引导脚本异常:', err && err.stack || err);
		process.exit(1);
	});
}

module.exports = {
	ROOT, DEFAULTS, parseArgs, request, extractTarGz, safeJoin,
	cmpVersion, depsReady, engineReady, findNpmCli, readJson,
};
