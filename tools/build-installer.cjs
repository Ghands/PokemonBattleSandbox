#!/usr/bin/env node
/**
 * 宝可梦对战沙盘 —— 统一安装包编译脚本
 *
 * 一份脚本同时支持 Windows / Linux，x64 / arm64，可交叉构建。
 * 只依赖 Node.js 内置模块 + 项目已有的 electron-builder / esbuild-wasm，
 * 不依赖 PowerShell、npm CLI、系统 tar 或 WSL，因此在 PATH 被裁剪的环境里也能跑。
 *
 * 用法：
 *   node tools/build-installer.cjs [选项]
 *   build-installer.bat --os windows --arch x64        (Windows)
 *   ./build-installer.sh --os linux --arch arm64       (Linux/macOS)
 *
 * 选项见 --help。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const buildEnv = require('./build-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const HOST_PLATFORM = process.platform;
const HOST_OS = HOST_PLATFORM === 'win32' ? 'windows' : HOST_PLATFORM === 'linux' ? 'linux' : 'mac';
const HOST_ARCH = /^(arm64|aarch64)$/.test(process.arch) ? 'arm64' : 'x64';
const IS_WINDOWS_HOST = HOST_PLATFORM === 'win32';

const OS_ALIAS = {
	win: 'windows', windows: 'windows', w: 'windows', win32: 'windows',
	linux: 'linux', lin: 'linux', l: 'linux',
	all: 'all', both: 'all',
};
const ARCH_ALIAS = {
	x64: 'x64', amd64: 'x64', x86_64: 'x64',
	arm64: 'arm64', aarch64: 'arm64', arm: 'arm64',
	all: 'all', both: 'all',
};
const WIN_TARGETS = new Set(['nsis', 'portable', 'msi', 'appx', 'zip', '7z', 'tar.gz', 'dir']);
const LINUX_TARGETS = new Set(['deb', 'rpm', 'appimage', 'snap', 'flatpak', 'pacman', 'apk', 'zip', '7z', 'tar.gz', 'tar.xz', 'tar.bz2', 'dir']);
const DEFAULT_MIRROR = 'https://npmmirror.com/mirrors/electron/';
const DEFAULT_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

const HELP = `
宝可梦对战沙盘 · 安装包编译脚本
============================================================
用法: node tools/build-installer.cjs [选项]

  -p, --os <os>          目标操作系统: windows | linux | all
                         默认当前系统 (${HOST_OS})
  -a, --arch <arch>      目标架构: x64 | arm64 | all
                         默认当前架构 (${HOST_ARCH})
  -t, --target <list>    产物类型, 逗号分隔。默认按平台自动选择:
                           windows -> nsis,portable
                           linux   -> ${IS_WINDOWS_HOST ? 'tar.gz (Windows 主机交叉构建)' : 'deb,appimage,tar.gz'}
                         可用 windows: nsis portable msi zip 7z tar.gz dir
                         可用 linux  : deb rpm appimage snap tar.gz tar.xz zip 7z dir
      --dir              等价于 --target dir (只出免安装目录, 最快)
  -o, --out <dir>        输出目录, 默认 release (相对项目根)
      --clean            构建前清空输出目录
      --rebuild-engine   强制重新编译 Pokemon Showdown 引擎 dist
      --skip-engine      跳过引擎构建与检查 (确认 dist 已存在时用)
      --no-mirror        不使用 npmmirror 国内镜像
      --electron-mirror <url>  自定义 Electron 下载镜像
      --dry-run          只打印构建计划, 不写任何文件
  -h, --help             显示本帮助

示例:
  node tools/build-installer.cjs --os windows --arch x64
  node tools/build-installer.cjs --os windows --arch arm64 --target nsis,portable
  node tools/build-installer.cjs --os linux --arch arm64
  node tools/build-installer.cjs --os linux --arch x64 --target deb,appimage   # 需 Linux 主机或自备 fpm
  node tools/build-installer.cjs --os all --arch all --out dist-all
  node tools/build-installer.cjs --os linux --arch x64 --dir --clean
  build-installer.bat --os all --arch all
  ./build-installer.sh -p linux -a arm64 -t tar.gz

说明:
  * 引擎 dist 是纯 JS, 与架构无关, 一次会话只编译一次。
  * Windows 主机可以交叉构建 Linux 包; 但 deb/rpm 需要 fpm, AppImage 需要 Linux
    工具链, 所以 Windows 主机默认只出 tar.gz (解压即用)。在 Linux 主机上运行
    同一条命令会自动额外产出 deb 和 AppImage。
  * Linux 主机同样可以交叉构建 Windows 的 nsis/portable 包。
  * --target 会作用于所有选定平台；--os all 且需要不同产物时，请按平台分两次运行。
  * 产物清单会写入 <out>/build-manifest.json。
`;

/* ------------------------------- 参数解析 ------------------------------- */

function parseArgs(argv) {
	const opts = {
		os: [], arch: [], targets: null, out: 'release', clean: false,
		rebuildEngine: false, skipEngine: false, mirror: true,
		electronMirror: null, dryRun: false, help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const raw = argv[i];
		let flag = raw, inline = null;
		const eq = raw.indexOf('=');
		if (eq > 0) { flag = raw.slice(0, eq); inline = raw.slice(eq + 1); }
		const value = () => inline !== null ? inline : (argv[++i]);
		switch (flag) {
			case '-h': case '--help': opts.help = true; break;
			case '-p': case '--os': pushMapped(opts.os, value(), OS_ALIAS, flag); break;
			case '-a': case '--arch': pushMapped(opts.arch, value(), ARCH_ALIAS, flag); break;
			case '-t': case '--target': opts.targets = splitList(value()); break;
			case '--dir': opts.targets = ['dir']; break;
			case '-o': case '--out': opts.out = value(); break;
			case '--clean': opts.clean = true; break;
			case '--rebuild-engine': opts.rebuildEngine = true; break;
			case '--skip-engine': opts.skipEngine = true; break;
			case '--no-mirror': opts.mirror = false; break;
			case '--electron-mirror': opts.electronMirror = value(); break;
			case '--dry-run': opts.dryRun = true; break;
			default: throw new Error(`未知参数: ${raw}（用 --help 查看用法）`);
		}
	}
	if (opts.help) return opts;
	if (!opts.os.length) opts.os.push(HOST_OS === 'mac' ? 'linux' : HOST_OS);
	if (!opts.arch.length) opts.arch.push(HOST_ARCH);
	opts.os = expand(opts.os, ['windows', 'linux']);
	opts.arch = expand(opts.arch, ['x64', 'arm64']);
	if (opts.targets) {
		opts.targets = opts.targets.map(t => t.toLowerCase().replace(/^\./, ''));
		for (const t of opts.targets) {
			if (!WIN_TARGETS.has(t) && !LINUX_TARGETS.has(t)) throw new Error(`不支持的产物类型: ${t}`);
		}
	}
	return opts;
}

function splitList(v) {
	if (v == null) throw new Error('列表参数不能为空');
	return String(v).split(',').map(s => s.trim()).filter(Boolean);
}

function pushMapped(arr, v, alias, flag) {
	if (v == null) throw new Error(`${flag} 缺少参数值`);
	for (const item of splitList(v)) {
		const mapped = alias[item.toLowerCase()];
		if (!mapped) throw new Error(`${flag} 不支持 "${item}"，可用: ${[...new Set(Object.values(alias))].join(', ')}`);
		if (!arr.includes(mapped)) arr.push(mapped);
	}
}

function expand(values, all) {
	if (values.includes('all')) return all.slice();
	return all.filter(v => values.includes(v));
}

/* --------------------------------- 工具 --------------------------------- */

function log(...a) { console.log(...a); }
function step(msg) { console.log(`\n==> ${msg}`); }
function ok(msg) { console.log(`    ${msg}`); }
function warn(msg) { console.log(`    ⚠ ${msg}`); }
function fail(msg) { throw new Error(msg); }
function sizeMb(n) { return (n / 1024 / 1024).toFixed(1) + ' MB'; }

function runNode(script, args = []) {
	const r = spawnSync(NODE, [script, ...args], { cwd: ROOT, stdio: 'inherit', env: process.env });
	if (r.error) throw r.error;
	if (r.status !== 0) fail(`${path.basename(script)} 执行失败（退出码 ${r.status}）`);
}

function whichSync(name) {
	const sep = IS_WINDOWS_HOST ? ';' : ':';
	const exts = IS_WINDOWS_HOST ? ['', '.exe', '.cmd', '.bat'] : [''];
	for (const dir of (process.env.PATH || '').split(sep)) {
		if (!dir) continue;
		for (const ext of exts) {
			const f = path.join(dir, name + ext);
			try { if (fs.statSync(f).isFile()) return f; } catch { /* next */ }
		}
	}
	return null;
}

/** 带重定向与超时的 HTTPS GET，返回 Buffer。 */
function httpsBuffer(url, redirects = 0) {
	return new Promise((resolve, reject) => {
		if (redirects > 5) return reject(new Error('重定向次数过多'));
		const req = https.get(url, { timeout: 30000, headers: { 'User-Agent': 'pbsim-build-installer', Accept: '*/*' } }, res => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				return resolve(httpsBuffer(new URL(res.headers.location, url).toString(), redirects + 1));
			}
			if (res.statusCode !== 200) {
				res.resume();
				return reject(new Error(`HTTP ${res.statusCode}: ${url}`));
			}
			const chunks = [];
			res.on('data', d => chunks.push(d));
			res.on('end', () => resolve(Buffer.concat(chunks)));
			res.on('error', reject);
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(new Error(`请求超时: ${url}`)); });
	});
}

async function httpsJson(url) {
	return JSON.parse((await httpsBuffer(url)).toString('utf8'));
}

/**
 * 极简 tar.gz 解压（npm 包 tarball 结构固定，不依赖系统 tar / 第三方模块）。
 * 处理常规文件、目录、GNU/PAX 扩展头，并做路径穿越防护。
 */
function extractTgz(gz, destDir) {
	const buf = zlib.gunzipSync(gz);
	let off = 0, longName = null, written = 0;
	while (off + 512 <= buf.length) {
		const hdr = buf.subarray(off, off + 512);
		off += 512;
		if (hdr.every(b => b === 0)) break;
		let name = hdr.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
		const prefix = hdr.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
		if (prefix) name = prefix + '/' + name;
		const sizeStr = hdr.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim();
		const size = parseInt(sizeStr || '0', 8) || 0;
		const type = String.fromCharCode(hdr[156] || 48);
		const data = buf.subarray(off, off + size);
		off += Math.ceil(size / 512) * 512;

		if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/, ''); continue; }
		if (type === 'x' || type === 'g') {
			const m = /path=([^\n]+)/.exec(data.toString('utf8'));
			if (m) longName = m[1];
			continue;
		}
		if (longName) { name = longName; longName = null; }

		const rel = name.replace(/^package\//, '').replace(/\\/g, '/');
		if (!rel || rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.split('/').includes('..')) continue;
		const dest = path.join(destDir, rel);
		if (type === '5') { fs.mkdirSync(dest, { recursive: true }); continue; }
		if (type !== '0' && type !== '\0' && type !== '7') continue;
		fs.mkdirSync(path.dirname(dest), { recursive: true });
		fs.writeFileSync(dest, data);
		written++;
	}
	return written;
}

/* ------------------------------ 前置检查 ------------------------------ */

const ENGINE_DIR = path.join(ROOT, 'pokemon-showdown-master');
const ENGINE_ENTRY = path.join(ENGINE_DIR, 'dist', 'sim', 'index.js');
const ENGINE_DEP = path.join(ENGINE_DIR, 'node_modules', 'ts-chacha20');

async function preflight(opts, plannedOs) {
	step('检查构建环境');
	const pkgPath = path.join(ROOT, 'package.json');
	if (!fs.existsSync(pkgPath)) fail('项目根目录下没有 package.json');
	const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
	const minNode = (pkg.engines && pkg.engines.node || '').match(/(\d+)\.(\d+)\.(\d+)/);
	if (minNode) {
		const want = Number(minNode[1]) * 10000 + Number(minNode[2]) * 100 + Number(minNode[3]);
		const cur = process.versions.node.split('.').map(Number);
		const have = cur[0] * 10000 + cur[1] * 100 + cur[2];
		if (have < want) fail(`Node.js 版本过低: v${process.versions.node}，需要 >= ${minNode[0]}.${minNode[1]}.${minNode[2]}`);
	}
	ok(`Node.js v${process.versions.node} · 宿主 ${HOST_OS}/${HOST_ARCH} · electron-builder ${require(path.join(ROOT, 'node_modules/electron-builder/package.json')).version}`);

	for (const f of ['node_modules/electron-builder/out/index.js', 'node_modules/esbuild-wasm/package.json', 'tools/build-engine.cjs']) {
		if (!fs.existsSync(path.join(ROOT, f))) fail(`缺少依赖或工具: ${f}（先在项目根目录执行 npm install）`);
	}
	ok('electron-builder / esbuild-wasm 已就绪');

	// 输出目录安全校验：必须是项目内或明确指定的独立目录，禁止指向项目根、主目录、盘符根。
	const outDir = path.resolve(ROOT, opts.out);
	const home = require('os').homedir();
	const suspicious = [ROOT, home, path.parse(outDir).root, path.dirname(ROOT)];
	if (suspicious.some(d => path.resolve(d).toLowerCase() === outDir.toLowerCase())) {
		fail(`拒绝清空/写入危险目录: ${outDir}（请用 --out 指定独立目录，如 release 或 dist-all）`);
	}
	if (!outDir.toLowerCase().startsWith(ROOT.toLowerCase() + path.sep)) {
		warn(`输出目录位于项目之外: ${outDir}`);
	}
	ok(`输出目录: ${outDir}`);

	// 图标
	const needIco = plannedOs.has('windows'), needPng = plannedOs.has('linux');
	if ((needIco && !fs.existsSync(path.join(ROOT, 'build/icon.ico'))) || (needPng && !fs.existsSync(path.join(ROOT, 'build/icon.png')))) {
		if (opts.dryRun) ok('（dry-run）图标缺失，实际构建时会调用 tools/make-icon.cjs 生成');
		else { step('生成应用图标'); runNode(path.join(ROOT, 'tools/make-icon.cjs')); ok('build/icon.ico + build/icon.png'); }
	} else ok('应用图标已就绪');

	// 引擎 dist（一次会话只构建一次，架构无关）
	if (!opts.skipEngine) {
		const need = opts.rebuildEngine || !fs.existsSync(ENGINE_ENTRY);
		if (need) {
			if (opts.dryRun) ok('（dry-run）引擎 dist 需要构建，实际构建时会执行 tools/build-engine.cjs');
			else {
				step('编译 Pokemon Showdown 引擎 dist（esbuild-wasm，约 1-3 分钟）');
				runNode(path.join(ROOT, 'tools/build-engine.cjs'), [ENGINE_DIR]);
				ok(`引擎入口: ${ENGINE_ENTRY}`);
			}
		} else ok('引擎 dist 已存在（加 --rebuild-engine 可强制重编译）');
	}

	// 引擎运行时依赖：extraResources 直接从这里拷贝，缺失时从 npm 单独下载该包。
	if (fs.existsSync(path.join(ENGINE_DEP, 'package.json'))) {
		ok('引擎运行时依赖 ts-chacha20 已就绪');
	} else if (opts.dryRun) {
		ok('（dry-run）ts-chacha20 缺失，实际构建时会从 npm 自动补齐');
	} else {
		step('补齐引擎运行时依赖 ts-chacha20');
		const registry = opts.mirror ? 'https://registry.npmmirror.com' : 'https://registry.npmjs.org';
		const meta = await httpsJson(`${registry}/ts-chacha20/latest`);
		const tarball = meta.dist && meta.dist.tarball;
		if (!tarball) fail('无法从 npm 获取 ts-chacha20 下载地址');
		const gz = await httpsBuffer(tarball);
		fs.mkdirSync(path.dirname(ENGINE_DEP), { recursive: true });
		const count = extractTgz(gz, ENGINE_DEP);
		if (!fs.existsSync(path.join(ENGINE_DEP, 'package.json'))) fail('ts-chacha20 解压结果不完整');
		ok(`ts-chacha20 ${meta.version}（${count} 个文件）`);
	}
	return { pkg, outDir };
}

/* ------------------------------ 目标能力 ------------------------------ */

function defaultTargets(os, hostPlatform = HOST_PLATFORM) {
	if (os === 'windows') return ['nsis', 'portable'];
	if (hostPlatform === 'win32') return ['tar.gz'];
	return ['deb', 'appimage', 'tar.gz'];
}

function targetWarnings(os, targets) {
	if (os !== 'linux' || !IS_WINDOWS_HOST) return;
	for (const t of targets) {
		if (['deb', 'rpm', 'pacman', 'apk'].includes(t) && !process.env.CUSTOM_FPM_PATH && !whichSync('fpm')) {
			warn(`${t} 需要 fpm（PATH 中未找到）；Windows 主机交叉构建通常会失败，可用 CUSTOM_FPM_PATH 指定 fpm，或改在 Linux 主机上构建`);
		}
		if (t === 'appimage' && !process.env.APPIMAGE_TOOLS_PATH) {
			warn('AppImage 需要 Linux 工具链（mksquashfs）；Windows 主机上通常会失败，可用 APPIMAGE_TOOLS_PATH 指定工具目录');
		}
	}
}

function validateTargets(os, targets) {
	const allowed = os === 'windows' ? WIN_TARGETS : LINUX_TARGETS;
	for (const t of targets) {
		if (!allowed.has(t)) fail(`产物类型 "${t}" 不适用于 ${os}（可用: ${[...allowed].join(', ')}）`);
	}
}

/* ------------------------------ 单次构建 ------------------------------ */

function prepareEnv(opts) {
	if (opts.electronMirror) {
		process.env.ELECTRON_MIRROR = opts.electronMirror;
	} else if (opts.mirror && !process.env.ELECTRON_MIRROR) {
		process.env.ELECTRON_MIRROR = DEFAULT_MIRROR;
	}
	if (opts.mirror && !process.env.ELECTRON_BUILDER_BINARIES_MIRROR) {
		process.env.ELECTRON_BUILDER_BINARIES_MIRROR = DEFAULT_BINARIES_MIRROR;
	}
	if (!process.env.CSC_IDENTITY_AUTO_DISCOVERY) process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
	// 宿主注入的 ELECTRON_RUN_AS_NODE 会让 electron-builder 误判，构建进程里清掉。
	delete process.env.ELECTRON_RUN_AS_NODE;
}

function buildConfig(pkg, os, arch, targets, outDir) {
	const config = JSON.parse(JSON.stringify(pkg.build || {}));
	config.directories = Object.assign({}, config.directories, { output: outDir });
	const shaped = targets.map(t => ({ target: t, arch: [arch] }));
	if (os === 'windows') {
		config.win = Object.assign({}, config.win, { target: shaped, icon: 'build/icon.ico' });
	} else {
		config.linux = Object.assign({
			icon: 'build/icon.png',
			category: 'Game',
			artifactName: 'PokemonBattleSim-${version}-${arch}.${ext}',
		}, config.linux, { target: shaped });
	}
	return config;
}

/* ------------------------- Windows 文件占用容错 ------------------------- */

const STAGE_ROOT = path.join(ROOT, '.cache', 'extra-resources');
let stagedOnce = false;

/**
 * 把 extraResources 的源先复制到一个干净的暂存区，再让 electron-builder 从暂存区
 * 拷贝。原因：源目录（pokemon-showdown-master/dist、node_modules/esbuild-wasm）常
 * 被杀毒实时防护/索引服务扫描，fs.copyFileSync（copyfile）以独占方式打开源文件时
 * 会 EBUSY；这里改用共享读 + 临时文件 + 原子改名，并跳过内容未变的文件。
 *
 * 注意：仅修改传入的 config.extraResources 是不够的。electron-builder 的
 * deepAssign 对数组采用 concat 合并，package.json 的 build.extraResources 仍会
 * 一起生效，于是 esbuild.wasm 依旧从 node_modules 直拷并触发 EBUSY。真正生效
 * 的做法是 writeEffectiveConfig()：把完整配置写成独立文件，以 config 字符串
 * 传给 build()，此时 electron-builder 不再读取 package.json 的 build 字段。
 */
function stageExtraResources(config) {
	// ts-chacha20 必须作为独立的一条 extraResources：electron-builder 会过滤
	// extraResources 里路径含 node_modules 的子目录，塞进 engine/ 内部会静默丢失。
	const jobs = [
		{ from: path.join(ENGINE_DIR, 'dist'), to: 'engine/dist' },
		{ from: ENGINE_DEP, to: 'ts-chacha20' },
		{ from: path.join(ROOT, 'node_modules', 'esbuild-wasm'), to: 'engine-build/esbuild-wasm' },
	];
	let copied = 0, skipped = 0;
	for (const job of jobs) {
		if (!fs.existsSync(job.from)) continue;
		const r = buildEnv.copyDirResilient(job.from, path.join(STAGE_ROOT, job.to));
		copied += r.copied;
		skipped += r.skipped;
	}
	for (const f of ['package.json', 'LICENSE']) {
		const src = path.join(ENGINE_DIR, f);
		if (!fs.existsSync(src)) continue;
		const r = buildEnv.copyFileResilient(src, path.join(STAGE_ROOT, 'engine', f));
		if (r === 'skipped') skipped++; else copied++;
	}
	// 用绝对路径，避免配置文件落在 .cache/ 后产生相对基准歧义。
	const abs = rel => path.join(STAGE_ROOT, rel).replace(/\\/g, '/');
	config.extraResources = [
		// 历史暂存可能残留 engine/node_modules，显式排除。
		{ from: abs('engine'), to: 'engine', filter: ['**/*', '!node_modules/**/*'] },
		{ from: abs('ts-chacha20'), to: 'engine/node_modules/ts-chacha20' },
		{ from: abs('engine-build'), to: 'engine-build' },
	];
	if (!stagedOnce) {
		ok(`extraResources 已从干净暂存区读取（新增 ${copied} / 复用 ${skipped} 个文件）`);
		stagedOnce = true;
	}
}

/**
 * 把最终配置写成独立的 JSON 文件，并以「文件路径」而非「配置对象」传给
 * electron-builder。传对象时它会与 package.json 的 build 字段做 deepAssign，
 * 数组是 concat 合并——暂存区条目只是追加，package.json 里指向
 * node_modules/esbuild-wasm 的旧条目仍会执行并触发 EBUSY。
 * 每次写唯一文件名，绝不覆盖已有文件，从根上避开 copyfile 目标锁。
 */
function writeEffectiveConfig(config, os, arch) {
	const dir = path.join(ROOT, '.cache', 'builder-config');
	fs.mkdirSync(dir, { recursive: true });
	const file = path.join(dir, `electron-builder-${os}-${arch}-${process.pid}-${Date.now()}.json`);
	fs.writeFileSync(file, JSON.stringify(config, null, 2), 'utf8');
	return file;
}

/** 打包前检查输出目录里是否已有被独占锁定的文件，提前给出可操作的提示。 */
function auditOutputLocks(outDir, unpackedName) {
	const locked = buildEnv.findLockedFiles(path.join(outDir, unpackedName, 'resources'));
	if (!locked.length) return;
	warn(`输出目录中有 ${locked.length} 个文件正被占用，覆盖它们会失败：`);
	for (const f of locked.slice(0, 8)) warn(`  ${path.relative(outDir, f)}`);
	warn('常见持有者：正在运行的 PokemonBattleSim.exe、杀毒实时防护、网盘/OneDrive 同步。');
	warn('请关闭后重试，或用 --out <全新目录>；被独占锁定的文件原地重试永远不会解锁。');
}

/**
 * 产物清单：以 electron-builder 返回的制品路径为准，额外补上免安装目录的主程序。
 * 只按时间戳扫描会混入上一个组合刚生成的文件，所以只在 produced 为空（dir 模式）时兜底扫描。
 */
function collectArtifacts(outDir, since, produced = [], unpackedName = null) {
	const found = new Map();
	function add(rel, minTime) {
		if (!rel || rel.startsWith('..') || /\.(yml|yaml|blockmap)$/i.test(path.basename(rel))) return;
		const f = path.join(outDir, rel);
		let st;
		try { st = fs.statSync(f); } catch { return; }
		if (!st.isFile() || st.mtimeMs < minTime) return;
		found.set(rel, { file: rel, size: st.size });
	}
	for (const f of produced) {
		add(path.relative(outDir, path.resolve(f)).replace(/\\/g, '/'), 0);
	}
	if (!fs.existsSync(outDir)) return [...found.values()].sort((a, b) => a.file.localeCompare(b.file));
	const dirs = unpackedName
		? [unpackedName]
		: fs.readdirSync(outDir, { withFileTypes: true }).filter(e => e.isDirectory() && /unpacked/i.test(e.name)).map(e => e.name);
	for (const dir of dirs) {
		for (const main of ['PokemonBattleSim.exe', 'pokemon-battle-sim', 'PokemonBattleSim']) {
			add(dir + '/' + main, since);
		}
	}
	if (produced.length === 0) {
		for (const ent of fs.readdirSync(outDir, { withFileTypes: true })) {
			if (ent.isFile()) add(ent.name, since);
		}
	}
	return [...found.values()].sort((a, b) => a.file.localeCompare(b.file));
}

async function buildOne(builder, pkg, os, arch, targets, outDir, opts) {
	const started = Date.now();
	step(`构建 ${os} / ${arch} → ${targets.join(', ')}`);
	const cross = (os === 'linux' && IS_WINDOWS_HOST) || (os === 'windows' && HOST_PLATFORM !== 'win32');
	if (cross) ok(`交叉构建（宿主 ${HOST_OS}/${HOST_ARCH}），首次会下载 ${os}/${arch} 的 Electron 运行时`);
	targetWarnings(os, targets);

	prepareEnv(opts);
	const config = buildConfig(pkg, os, arch, targets, outDir);
	const platform = os === 'windows' ? builder.Platform.WINDOWS : builder.Platform.LINUX;
	const archEnum = builder.Arch[arch];
	if (typeof archEnum !== 'number') fail(`无法解析架构: ${arch}`);
	const targetsMap = platform.createTarget(targets, archEnum);
	const unpackedName = os === 'windows'
		? (arch === 'x64' ? 'win-unpacked' : 'win-arm64-unpacked')
		: (arch === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked');

	if (!opts.dryRun) {
		try { stageExtraResources(config); }
		catch (e) { warn(`extraResources 暂存失败，改用原目录直接拷贝：${e.message}`); }
		auditOutputLocks(outDir, unpackedName);
	}

	if (opts.dryRun) {
		ok(`electron-builder.build({ platform=${os}, arch=${arch}, targets=[${targets.join(', ')}] })`);
		ok(`config.directories.output = ${outDir}`);
		return { os, arch, targets, outDir, artifacts: [], ms: 0, dryRun: true };
	}

	const configPath = writeEffectiveConfig(config, os, arch);
	ok(`electron-builder 使用独立配置：${path.relative(ROOT, configPath)}`);

	let produced = [];
	try {
		// config 传字符串路径：electron-builder 只读取该文件，不再合并 package.json
		// 的 build 字段，暂存区 extraResources 才能完全取代旧条目。
		produced = await builder.build({ config: configPath, targets: targetsMap, projectDir: ROOT });
	} catch (err) {
		const msg = err && err.message || String(err);
		let hint = '';
		if (buildEnv.isTransientFsError(err)) {
			const locked = buildEnv.findLockedFiles(path.join(outDir, unpackedName, 'resources'));
			hint = `\n  文件占用诊断：${locked.length ? `以下文件仍被锁定 ${locked.slice(0, 5).join(', ')}` : '未发现持久锁定，可能是瞬时占用'}` +
				'\n  被独占锁定的文件无法覆盖/改名/删除，原地重试不会解锁；请关闭正在运行的客户端与杀毒实时防护，或用 --out <全新目录> 重新打包。';
		}
		throw new Error(`${os}/${arch} 构建失败: ${msg}${hint}`);
	}
	const artifacts = collectArtifacts(outDir, started, produced, unpackedName);
	ok(`完成，用时 ${((Date.now() - started) / 1000).toFixed(0)}s，产物 ${artifacts.length} 项`);
	for (const a of artifacts) ok(`  ${a.file.padEnd(52)} ${sizeMb(a.size)}`);
	return { os, arch, targets, outDir, artifacts, ms: Date.now() - started, dryRun: false };
}

/* --------------------------------- 主流程 --------------------------------- */

async function main() {
	let opts;
	try { opts = parseArgs(process.argv.slice(2)); }
	catch (e) { console.error(`\n参数错误: ${e.message}\n`); process.exit(2); }
	if (opts.help) { console.log(HELP); return; }

	// 直接调用本脚本（不经过 build.bat / bootstrap.cjs）时也要保证便携 Node 在
	// PATH 上，否则 electron-builder 拉起的子进程与生命周期脚本找不到 node。
	buildEnv.applyNodeOnPath(process.env);

	const combos = [];
	for (const os of opts.os) for (const arch of opts.arch) {
		const targets = opts.targets ? opts.targets.slice() : defaultTargets(os);
		validateTargets(os, targets);
		combos.push({ os, arch, targets });
	}

	console.log('\n========================================');
	console.log(' 宝可梦对战沙盘 · 安装包编译');
	console.log('========================================');
	console.log(` 目标: ${combos.map(c => `${c.os}/${c.arch} [${c.targets.join(',')}]`).join('  |  ')}`);
	console.log(` 镜像: ${opts.mirror ? (opts.electronMirror || DEFAULT_MIRROR) : '关闭（使用官方源）'}`);
	if (opts.dryRun) console.log(' 模式: dry-run（只读，不写文件）');

	const plannedOs = new Set(combos.map(c => c.os));
	const { pkg, outDir } = await preflight(opts, plannedOs);

	if (opts.clean) {
		step(`清理输出目录 ${outDir}`);
		if (opts.dryRun) ok('（dry-run）跳过删除');
		else { fs.rmSync(outDir, { recursive: true, force: true }); ok('已清空'); }
	}
	if (!opts.dryRun) fs.mkdirSync(outDir, { recursive: true });

	const builder = require(path.join(ROOT, 'node_modules/electron-builder'));
	const results = [], failures = [];
	for (const c of combos) {
		try {
			results.push(await buildOne(builder, pkg, c.os, c.arch, c.targets, outDir, opts));
		} catch (e) {
			console.error(`\n!! ${e.message}\n`);
			failures.push({ os: c.os, arch: c.arch, error: e.message });
		}
	}

	step('构建汇总');
	for (const r of results) ok(`${r.os}/${r.arch}: ${r.targets.join(',')} → ${r.artifacts.length} 项产物${r.dryRun ? '（dry-run）' : ''}`);
	for (const f of failures) console.error(`    ✗ ${f.os}/${f.arch}: ${f.error.slice(0, 200)}`);

	if (!opts.dryRun) {
		const manifest = {
			generatedAt: new Date().toISOString(),
			host: { os: HOST_OS, arch: HOST_ARCH, node: process.versions.node },
			output: outDir,
			mirror: opts.mirror ? (process.env.ELECTRON_MIRROR || null) : null,
			results, failures,
		};
		fs.writeFileSync(path.join(outDir, 'build-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
		ok(`清单: ${path.join(outDir, 'build-manifest.json')}`);
	}
	if (failures.length) {
		console.error(`\n有 ${failures.length} 个组合构建失败，详见上方日志。`);
		process.exit(1);
	}
	console.log('\n完成。\n');
}

if (require.main === module) {
	main().catch(err => {
		console.error('\n构建脚本异常:', err && err.stack || err);
		process.exit(1);
	});
}

module.exports = {
	ROOT, HOST_OS, HOST_ARCH, IS_WINDOWS_HOST,
	parseArgs, splitList, expand, extractTgz, httpsBuffer, httpsJson,
	defaultTargets, validateTargets, buildConfig, prepareEnv, collectArtifacts,
};
