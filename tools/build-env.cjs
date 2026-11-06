#!/usr/bin/env node
/**
 * 构建环境公共工具
 * =====================================================================
 * 两个在「干净机器」上反复出现的问题都在这里解决：
 *
 * 1) 便携 Node 不在 PATH 上。
 *    build.bat / build.sh 下载的 Node 放在 .runtime/node/，它不会自动进入系统
 *    PATH。但下面两处都用「裸 node」命令启动子进程：
 *      - electron-winstaller 的 install 脚本： "node ./script/select-7z-arch.js"
 *      - esbuild-wasm 的服务进程： child_process.spawn('node', ['bin/esbuild', ...])
 *    两者都会报「'node' 不是内部或外部命令」或 "spawn node ENOENT"。
 *    npm 生命周期脚本是在 cmd.exe 里跑的，靠 PATH 找 node；esbuild-wasm 更是
 *    硬编码了 'node'。唯一可靠的修法是把当前 node 可执行文件所在目录前置到
 *    PATH（.cmd 假壳不行：child_process.spawn 无法直接执行 .cmd/.bat）。
 *
 * 2) Windows 上 fs.copyFileSync（报错里的 syscall 名就是 copyfile）遇到被独占
 *    锁定的目标文件。实测：目标被 FileShare.None 占用时，copyfile / rename /
 *    直接写入 / 把文件改名让位 全部失败，重复重试永远不会解锁；只有写到
 *    「另一个路径」才能成功。所以这里提供：
 *      - copyFileResilient：共享读源文件 + 临时文件 + 原子改名 + 同内容跳过 +
 *        有限重试，能扛住杀毒/索引服务造成的瞬时锁；
 *      - findLockedFiles / freshOutDir：识别「持久锁」，交给上层换一个全新输出
 *        目录，而不是原地死等。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const IS_WIN = process.platform === 'win32';
const PATH_SEP = IS_WIN ? ';' : ':';
const NODE_BIN_NAME = IS_WIN ? 'node.exe' : 'node';

/** 当前 Node（或 Electron with ELECTRON_RUN_AS_NODE）可执行文件所在目录。 */
function nodeDir() {
	return path.dirname(process.execPath);
}

function normalize(p) {
	try { return path.resolve(p).toLowerCase(); }
	catch { return String(p).toLowerCase(); }
}

/**
 * 返回一份把 nodeDir 前置到 PATH 的环境变量副本，不修改入参。
 * 同时补上 npm_node_execpath，便于 npm 生命周期脚本定位 node。
 */
function withNodeOnPath(env = process.env) {
	const out = { ...env };
	const dir = nodeDir();
	const cur = out.PATH || out.Path || '';
	const parts = cur.split(PATH_SEP).filter(Boolean);
	if (!parts.some(d => normalize(d) === normalize(dir))) {
		out.PATH = dir + (cur ? PATH_SEP + cur : '');
		// 普通 env 对象里 PATH / Path 可能同时存在；统一，避免子进程收到两份。
		if ('Path' in out && out.Path !== out.PATH) out.Path = out.PATH;
	}
	if (!out.npm_node_execpath) out.npm_node_execpath = process.execPath;
	return out;
}

/** 就地给 env 打补丁（脚本主流程用这个，所有子进程自动继承）。 */
function applyNodeOnPath(env = process.env) {
	const patched = withNodeOnPath(env);
	env.PATH = patched.PATH;
	if ('Path' in env) {
		try { env.Path = patched.PATH; } catch { /* 只读属性，忽略 */ }
	}
	env.npm_node_execpath = patched.npm_node_execpath;
	return env;
}

/** PATH 里是否真的能解析出可执行的 node（.cmd 假壳不算，spawn 用不了）。 */
function nodeCommandResolvable(env = process.env) {
	const cur = env.PATH || env.Path || '';
	for (const dir of cur.split(PATH_SEP)) {
		if (!dir) continue;
		try { if (fs.statSync(path.join(dir, NODE_BIN_NAME)).isFile()) return true; }
		catch { /* 继续找 */ }
	}
	return false;
}

/**
 * 兜底：已打包客户端的「更新引擎」用 Electron 主程序（ELECTRON_RUN_AS_NODE=1）
 * 当 Node 跑 build-engine.cjs，此时机器上根本没有 node 命令，esbuild-wasm
 * 固定的 spawn('node') 必然 ENOENT。把裸 node 重定向到当前可执行文件即可。
 * 只在确实找不到 node 命令时装补丁，构建包主流程（真 node）不会触发。
 */
let spawnShimInstalled = false;
function installNodeSpawnFallback() {
	if (spawnShimInstalled || nodeCommandResolvable()) return false;
	if (/^node(\.exe)?$/i.test(path.basename(process.execPath))) return false;
	spawnShimInstalled = true;
	const cp = require('child_process');
	const original = cp.spawn;
	cp.spawn = function (command, args, options) {
		if (command === 'node' || command === 'node.exe') {
			const env = Object.assign({}, (options && options.env) || process.env, { ELECTRON_RUN_AS_NODE: '1' });
			return original.call(this, process.execPath, args, Object.assign({}, options, { env }));
		}
		return original.apply(this, arguments);
	};
	return true;
}

/** Windows 文件占用类错误（含中文系统提示）。 */
function isTransientFsError(err) {
	if (!err) return false;
	// 不收 EACCES：只读文件也会报 EACCES，那不是「占用」，据此提示用户关客户端会误导。
	if (['EBUSY', 'EPERM', 'UNKNOWN'].includes(err.code)) return true;
	return /EBUSY|EPERM|resource busy or locked|os error 32|sharing violation|operation did not complete|另一个程序正在使用/i
		.test(String(err.message || ''));
}

function sleepSync(ms) {
	try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
	catch { /* 环境不支持时退化为忙等 */ const end = Date.now() + ms; while (Date.now() < end) { /* noop */ } }
}

function lockHint(dest, src, err) {
	return [
		`无法写入文件: ${dest}`,
		`来源: ${src}`,
		`底层错误: ${(err && err.code) || 'UNKNOWN'} ${(err && err.message || '').slice(0, 200)}`,
		'',
		'Windows 上目标文件若被正在运行的 PokemonBattleSim.exe、杀毒软件实时防护、',
		'网盘/OneDrive 同步或索引服务独占，覆盖、改名、删除都会失败，原地重试不会解锁。',
		'处理办法：关闭正在运行的客户端与实时扫描，或用 --out <全新目录> / --clean 重新打包；',
		'构建脚本在检测到持久占用时会自动切换到一个全新的输出目录。',
	].join('\n');
}

function readFileResilient(src, attempts, delayMs) {
	let last;
	for (let i = 0; i < attempts; i++) {
		try {
			// readFileSync 用共享读打开，比 CopyFileW 更宽容：源文件被扫描时仍能读。
			return fs.readFileSync(src);
		} catch (e) {
			last = e;
			if (!isTransientFsError(e)) break;
			if (i < attempts - 1) sleepSync(Math.min(delayMs * (i + 1), 1200));
		}
	}
	const err = new Error(lockHint(src, '<读取源>', last));
	err.cause = last;
	throw err;
}

/**
 * 抗占用复制。返回 'skipped' | 'replaced' | 'overwritten'。
 *  - 目标内容一致直接跳过，不触碰文件（重试时不再重复触发杀毒扫描）；
 *  - 先写同目录临时文件，再 rename 原子替换，避免 copyfile 直接打开被锁目标；
 *  - 遇到瞬时占用做有限次递增退避重试；
 *  - 持久占用抛出带处置建议的明确错误，绝不无限重试。
 */
function copyFileResilient(src, dest, opts = {}) {
	const attempts = Math.max(1, opts.attempts || 6);
	const delayMs = opts.delayMs || 150;
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	const data = readFileResilient(src, attempts, delayMs);

	try {
		if (fs.statSync(dest).size === data.length && fs.readFileSync(dest).equals(data)) return 'skipped';
	} catch { /* 目标不存在 / 暂不可读，正常走复制 */ }

	let last;
	for (let i = 0; i < attempts; i++) {
		const tmp = `${dest}.pbsim-${process.pid}-${i}.tmp`;
		try {
			fs.writeFileSync(tmp, data);
			try {
				fs.renameSync(tmp, dest);
				return 'replaced';
			} catch (e) {
				if (!isTransientFsError(e)) throw e;
				// rename 覆盖失败（目标被占用）时，最后试一次原地写入。
				fs.writeFileSync(dest, data);
				try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
				return 'overwritten';
			}
		} catch (e) {
			last = e;
			try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
			if (!isTransientFsError(e)) break;
			if (i < attempts - 1) sleepSync(Math.min(delayMs * (i + 1), 1200));
		}
	}
	const err = new Error(lockHint(dest, src, last));
	err.cause = last;
	throw err;
}

/** 递归复制目录，逐文件走抗占用复制。返回 { copied, skipped }。 */
function copyDirResilient(srcDir, destDir, opts = {}) {
	let copied = 0, skipped = 0;
	const stack = [''];
	while (stack.length) {
		const rel = stack.pop();
		const cur = path.join(srcDir, rel);
		let entries;
		try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			const childRel = rel ? path.join(rel, e.name) : e.name;
			if (e.isDirectory()) stack.push(childRel);
			else if (e.isFile()) {
				if (opts.filter && !opts.filter(childRel.replace(/\\/g, '/'))) continue;
				const r = copyFileResilient(path.join(srcDir, childRel), path.join(destDir, childRel), opts);
				if (r === 'skipped') skipped++; else copied++;
			}
		}
	}
	return { copied, skipped };
}

/** 扫描目录里「无法以写方式打开」的文件，用于判断是否存在持久锁。 */
function findLockedFiles(dir, limit = 12) {
	const out = [];
	if (!fs.existsSync(dir)) return out;
	const stack = [dir];
	while (stack.length && out.length < limit) {
		const cur = stack.pop();
		let entries;
		try { entries = fs.readdirSync(cur, { withFileTypes: true }); }
		catch { continue; }
		for (const e of entries) {
			if (out.length >= limit) break;
			const f = path.join(cur, e.name);
			if (e.isDirectory()) stack.push(f);
			else if (e.isFile()) {
				let fd;
				try { fd = fs.openSync(f, 'r+'); fs.closeSync(fd); }
				catch (err) { if (isTransientFsError(err)) out.push(f); }
			}
		}
	}
	return out;
}

/** 持久占用时换一个全新输出目录，绕开被锁定的目标路径。 */
function freshOutDir(base, attempt) {
	return `${String(base).replace(/[\\/]+$/, '')}-retry-${attempt}`;
}

module.exports = {
	nodeDir, withNodeOnPath, applyNodeOnPath, nodeCommandResolvable,
	installNodeSpawnFallback, isTransientFsError, sleepSync,
	copyFileResilient, copyDirResilient, findLockedFiles, freshOutDir,
};
