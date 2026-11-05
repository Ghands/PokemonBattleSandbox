'use strict';
/**
 * Engine / data manager for the packaged desktop app.
 *
 * Owns three things:
 *   1. Where the engine lives (userData/settings.json, movable at runtime).
 *   2. Which upstream revision it corresponds to (engine-meta.json, kept
 *      inside the engine directory so it travels with the data).
 *   3. Updating from GitHub: check commit -> download tarball -> rebuild
 *      dist with the bundled esbuild-wasm -> atomically swap with rollback.
 *
 * No credentials are involved. Network access is limited to api.github.com
 * and codeload.github.com. Remote code is never executed: TypeScript sources
 * are only transpiled by esbuild in a child process.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const https = require('https');
const { spawn, spawnSync } = require('child_process');

const REPO = 'smogon/pokemon-showdown';
const BRANCH = 'master';
const ENGINE_DIR_NAME = 'engine';
const SETTINGS_FILE = 'settings.json';
const META_FILE = 'engine-meta.json';

function nowIso() { return new Date().toISOString(); }

function safeJoin(root, rel) {
	const parts = rel.replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..');
	if (!parts.length) return null;
	return path.join(root, ...parts);
}

function readJson(file, fallback) {
	try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
	catch { return fallback; }
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp-${process.pid}`;
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
	fs.renameSync(tmp, file);
}

function existsEngineDir(dir) {
	return !!dir && fs.existsSync(path.join(dir, 'dist', 'sim', 'index.js'));
}

function httpGet(url, { json = false, timeout = 30000 } = {}) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			timeout,
			headers: { 'User-Agent': 'PokemonBattleSim-Updater', 'Accept': json ? 'application/vnd.github+json' : 'application/octet-stream' },
		}, res => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				httpGet(res.headers.location, { json, timeout }).then(resolve, reject);
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`HTTP ${res.statusCode}：${url.split('?')[0]}`));
				return;
			}
			const chunks = [];
			res.on('data', d => chunks.push(d));
			res.on('end', () => {
				const buf = Buffer.concat(chunks);
				if (!json) { resolve(buf); return; }
				try { resolve(JSON.parse(buf.toString('utf8'))); }
				catch (err) { reject(new Error(`响应不是有效 JSON：${err.message}`)); }
			});
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(new Error(`网络超时：${url.split('?')[0]}`)); });
	});
}

function downloadFile(url, file, onBytes) {
	return new Promise((resolve, reject) => {
		const req = https.get(url, {
			timeout: 60000,
			headers: { 'User-Agent': 'PokemonBattleSim-Updater' },
		}, res => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				downloadFile(res.headers.location, file, onBytes).then(resolve, reject);
				return;
			}
			if (res.statusCode !== 200) {
				res.resume();
				reject(new Error(`下载失败：HTTP ${res.statusCode}`));
				return;
			}
			const total = Number(res.headers['content-length']) || 0;
			let received = 0;
			let lastAt = 0;
			let lastMb = -1;
			const out = fs.createWriteStream(file);
			res.on('data', d => {
				received += d.length;
				if (!onBytes) return;
				// Throttle: codeload streams tiny chunks, one IPC event per chunk
				// would flood the renderer.
				const now = Date.now();
				const mb = Math.floor(received / 104857.6) / 10;
				if (now - lastAt > 300 || mb !== lastMb) {
					lastAt = now;
					lastMb = mb;
					onBytes(received, total);
				}
			});
			res.pipe(out);
			out.on('finish', () => out.close(() => resolve(received)));
			out.on('error', reject);
		});
		req.on('error', reject);
		req.on('timeout', () => { req.destroy(new Error('下载超时')); });
	});
}

/** Minimal tar extractor (USTAR / pax headers), enough for GitHub tarballs. */
function extractTarGz(tgzFile, destDir) {
	const buf = zlib.gunzipSync(fs.readFileSync(tgzFile));
	let off = 0;
	let longName = null;
	let files = 0;
	while (off + 512 <= buf.length) {
		const head = buf.subarray(off, off + 512);
		off += 512;
		if (head.every(b => b === 0)) break;
		const readStr = (start, len) => head.subarray(start, start + len).toString('utf8').replace(/\0.*$/, '').trim();
		let name = readStr(0, 100);
		const prefix = readStr(345, 500);
		if (prefix) name = `${prefix}/${name}`;
		const sizeRaw = readStr(124, 12);
		const size = parseInt(sizeRaw, 8) || 0;
		const type = String.fromCharCode(head[156] || 48);
		const padded = Math.ceil(size / 512) * 512;
		const body = buf.subarray(off, off + size);
		off += padded;

		if (type === 'x' || type === 'g') continue;              // pax metadata
		if (type === 'L') { longName = body.toString('utf8').replace(/\0.*$/, ''); continue; }
		if (longName) { name = longName; longName = null; }
		if (!name) continue;
		const target = safeJoin(destDir, name);
		if (!target) continue;
		if (type === '5') { fs.mkdirSync(target, { recursive: true }); continue; }
		if (type !== '0' && type !== '\0' && type !== '7') continue;
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.writeFileSync(target, body);
		files++;
	}
	if (!files) throw new Error('源码包解压结果为空');
	return files;
}

function findRepoRoot(extractDir) {
	for (const entry of fs.readdirSync(extractDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidate = path.join(extractDir, entry.name);
		if (fs.existsSync(path.join(candidate, 'sim')) && fs.existsSync(path.join(candidate, 'data'))) return candidate;
	}
	throw new Error('源码包中未找到 sim/ 与 data/ 目录');
}

function createEngineManager(options = {}) {
	const {
		userDataPath = path.join(os.homedir(), '.pbsim-userdata'),
		resourcesPath = process.resourcesPath,
		projectRoot = path.join(__dirname, '..'),
		buildScript = path.join(__dirname, '..', 'tools', 'build-engine.cjs'),
		esbuildDir = null,
		execPath = process.execPath,
		dialog = null,
		onProgress = null,
	} = options;

	const settingsPath = path.join(userDataPath, SETTINGS_FILE);

	function progress(stage, text, percent) {
		if (onProgress) onProgress({ stage, text, percent: percent === undefined ? null : percent });
	}

	function readSettings() { return readJson(settingsPath, {}); }
	function writeSettings(next) { writeJson(settingsPath, { ...readSettings(), ...next }); }

	function defaultEngineDir() {
		if (typeof resourcesPath === 'string') {
			const packed = path.join(resourcesPath, ENGINE_DIR_NAME);
			if (existsEngineDir(packed)) return packed;
		}
		return path.join(projectRoot, 'pokemon-showdown-master');
	}

	function engineDir() {
		const configured = readSettings().engineDir;
		if (existsEngineDir(configured)) return configured;
		if (process.env.PBSIM_ENGINE && existsEngineDir(process.env.PBSIM_ENGINE)) {
			return path.resolve(process.env.PBSIM_ENGINE);
		}
		return defaultEngineDir();
	}

	function metaPath(dir = engineDir()) { return path.join(dir, META_FILE); }
	function readMeta(dir = engineDir()) { return readJson(metaPath(dir), null); }
	function writeMeta(meta, dir = engineDir()) { writeJson(metaPath(dir), meta); }

	function localVersion(dir = engineDir()) {
		try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; }
		catch { return null; }
	}

	function getInfo() {
		const dir = engineDir();
		let writable = false;
		try { fs.accessSync(path.join(dir, 'dist'), fs.constants.W_OK); writable = true; }
		catch { /* read-only install location */ }
		return {
			engineDir: dir,
			version: localVersion(dir),
			meta: readMeta(dir),
			isPackaged: !!resourcesPath && dir.startsWith(resourcesPath),
			writable,
			settingsPath,
		};
	}

	async function chooseDir(browserWindow) {
		if (!dialog) throw new Error('此环境不支持目录选择');
		const res = await dialog.showOpenDialog(browserWindow, {
			title: '选择引擎与数据的存放位置',
			buttonLabel: '选择此目录',
			properties: ['openDirectory', 'createDirectory'],
		});
		if (res.canceled || !res.filePaths || !res.filePaths.length) return null;
		return res.filePaths[0];
	}

	async function moveEngine(targetParent) {
		if (!targetParent || typeof targetParent !== 'string') throw new Error('未选择目标位置');
		const current = engineDir();
		if (!existsEngineDir(current)) throw new Error('当前引擎目录无效，无法移动');
		const target = path.join(path.resolve(targetParent), ENGINE_DIR_NAME);
		if (path.resolve(target) === path.resolve(current)) {
			return { moved: false, engineDir: current, message: '新位置与当前位置相同' };
		}
		if (existsEngineDir(target)) {
			throw new Error(`目标位置已存在引擎数据：${target}\n请先选择另一个目录，或手动删除该文件夹。`);
		}
		progress('move', '正在复制引擎与数据到新位置…', null);
		const tmp = `${target}.tmp-${Date.now()}`;
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.cpSync(current, tmp, { recursive: true, force: true });
			if (!existsEngineDir(tmp)) throw new Error('复制后的引擎数据不完整');
			fs.renameSync(tmp, target);
		} catch (err) {
			try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
			throw new Error(`移动失败：${err.message}`);
		}
		writeSettings({ engineDir: target, engineMovedAt: nowIso() });
		progress('move', '正在清理原位置…', null);
		let warning = null;
		try { fs.rmSync(current, { recursive: true, force: true }); }
		catch (err) { warning = `新位置已生效，但原目录未能删除（${err.message}），可稍后手动清理：${current}`; }
		progress('move', '引擎位置已更新', 100);
		return { moved: true, engineDir: target, warning, message: `引擎与数据已移动到：${target}` };
	}

	async function checkUpdate() {
		progress('check', '正在查询 GitHub 上的最新提交…', null);
		const commit = await httpGet(`https://api.github.com/repos/${REPO}/commits/${BRANCH}`, { json: true });
		if (!commit || !commit.sha) throw new Error('GitHub 返回的提交信息无效');
		const remoteSha = commit.sha;
		let remoteVersion = null;
		try {
			const pkg = await httpGet(`https://api.github.com/repos/${REPO}/contents/package.json?ref=${remoteSha}`, { json: true });
			remoteVersion = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')).version;
		} catch { /* version is informational only */ }
		const dir = engineDir();
		const meta = readMeta(dir);
		// Without a recorded revision we cannot prove the local build matches
		// upstream, so treat it as needing a sync; that first sync records the sha.
		const hasUpdate = !meta || !meta.sha || meta.sha !== remoteSha;
		const result = {
			hasUpdate,
			remoteSha,
			remoteVersion,
			remoteDate: commit.commit?.committer?.date || null,
			localSha: meta?.sha || null,
			localVersion: localVersion(dir),
			syncedAt: meta?.syncedAt || null,
			engineDir: dir,
			message: hasUpdate ? '发现新版本，可以更新' : '已是最新版本',
		};
		progress('check', result.message, 100);
		return result;
	}

	function runBuild(repoDir) {
		return new Promise((resolve, reject) => {
			const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
			if (esbuildDir) env.PBSIM_ESBUILD = esbuildDir;
			const proc = spawn(execPath, [buildScript, repoDir], {
				env, stdio: ['ignore', 'pipe', 'pipe'],
			});
			let out = '', err = '';
			proc.stdout.on('data', d => { out += d.toString(); });
			proc.stderr.on('data', d => { err += d.toString(); });
			proc.on('error', reject);
			proc.on('close', code => {
				if (code !== 0) return reject(new Error(`引擎编译失败（退出码 ${code}）：${(err || out).slice(-1200)}`));
				resolve(out);
			});
		});
	}

	function verifyDist(distDir) {
		const required = [
			'sim/index.js',
			'data/pokedex.js', 'data/moves.js', 'data/abilities.js', 'data/items.js',
			'data/learnsets.js', 'data/formats-data.js', 'data/mods',
		];
		for (const rel of required) {
			if (!fs.existsSync(path.join(distDir, rel))) throw new Error(`编译产物缺少 dist/${rel}`);
		}
		const entry = path.join(distDir, 'sim', 'index.js');
		const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
		const probe = spawnSync(execPath, ['-e', `require(${JSON.stringify(entry)});process.stdout.write('OK')`], {
			env, encoding: 'utf8', timeout: 60000,
		});
		if (probe.status !== 0 || !String(probe.stdout || '').includes('OK')) {
			throw new Error(`新引擎无法加载：${String(probe.stderr || probe.error || '').slice(-600)}`);
		}
	}

	function replaceDist(dir, repoDir, meta) {
		const dist = path.join(dir, 'dist');
		const backup = path.join(dir, 'dist.backup');
		const newDist = path.join(repoDir, 'dist');
		if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
		const hadDist = fs.existsSync(dist);
		if (hadDist) fs.renameSync(dist, backup);
		try {
			fs.cpSync(newDist, dist, { recursive: true, force: true });
			for (const file of ['package.json', 'LICENSE']) {
				const src = path.join(repoDir, file);
				if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, file));
			}
			verifyDist(dist);
			writeMeta(meta, dir);
			fs.rmSync(backup, { recursive: true, force: true });
		} catch (err) {
			try { fs.rmSync(dist, { recursive: true, force: true }); } catch { /* ignore */ }
			if (hadDist) fs.renameSync(backup, dist);
			throw new Error(`替换引擎失败，已回滚：${err.message}`);
		}
	}

	async function updateEngine() {
		const check = await checkUpdate();
		if (!check.hasUpdate) {
			return { updated: false, message: '已是最新版本', ...check };
		}
		const dir = check.engineDir;
		const work = fs.mkdtempSync(path.join(os.tmpdir(), 'pbsim-update-'));
		const tgz = path.join(work, 'source.tar.gz');
		const extractDir = path.join(work, 'source');
		try {
			progress('download', '正在从 GitHub 下载最新引擎与数据…', null);
			await downloadFile(`https://codeload.github.com/${REPO}/tar.gz/${check.remoteSha}`, tgz, (got, total) => {
				progress('download', `正在下载源码：${(got / 1024 / 1024).toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB` : ''}`,
					total ? Math.min(95, Math.round(got / total * 100)) : null);
			});
			progress('extract', '正在解压源码…', null);
			fs.mkdirSync(extractDir, { recursive: true });
			extractTarGz(tgz, extractDir);
			const repoDir = findRepoRoot(extractDir);
			if (!fs.existsSync(path.join(repoDir, 'tsconfig.json'))) {
				fs.writeFileSync(path.join(repoDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'es2020' } }, null, 2));
			}
			progress('build', '正在编译引擎与数据（约 1–3 分钟）…', null);
			await runBuild(repoDir);
			progress('install', '正在替换引擎与数据…', null);
			replaceDist(dir, repoDir, {
				source: REPO,
				branch: BRANCH,
				sha: check.remoteSha,
				version: check.remoteVersion || localVersion(dir),
				syncedAt: nowIso(),
			});
			progress('done', '更新完成', 100);
			return {
				updated: true,
				message: `已更新到最新引擎与数据（${String(check.remoteSha).slice(0, 7)}）`,
				sha: check.remoteSha,
				version: check.remoteVersion,
				engineDir: dir,
			};
		} finally {
			try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* ignore */ }
		}
	}

	return { getInfo, chooseDir, moveEngine, checkUpdate, updateEngine, engineDir, readSettings, writeSettings, readMeta, writeMeta, settingsPath };
}

module.exports = { createEngineManager, extractTarGz, REPO, BRANCH, ENGINE_DIR_NAME, META_FILE };
