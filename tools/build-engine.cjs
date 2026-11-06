#!/usr/bin/env node
/**
 * Build the vendored Pokemon Showdown engine into `<engine>/dist` using
 * esbuild-wasm (pure WebAssembly), so it works on platforms where the native
 * esbuild binary cannot be executed (e.g. HarmonyOS sandbox).
 *
 * Usage:
 *   node tools/build-engine.cjs [engineDir]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const buildEnv = require('./build-env.cjs');

// esbuild-wasm 固定用 child_process.spawn('node', ['bin/esbuild', ...]) 启动服务，
// 便携 Node 不在 PATH 时会 ENOENT。先把当前 node 目录前置到 PATH；若宿主是
// 已打包客户端（没有 node 命令），再装一层 spawn 重定向兜底。
buildEnv.applyNodeOnPath(process.env);
buildEnv.installNodeSpawnFallback();

const engineDir = path.resolve(process.argv[2] || path.join(__dirname, '..', 'pokemon-showdown-master'));
const distDir = path.join(engineDir, 'dist');
let esbuild;
// PBSIM_ESBUILD points at the esbuild-wasm copy shipped inside the packaged
// app, so an engine update can rebuild dist without any project node_modules.
const esbuildCandidates = [
	process.env.PBSIM_ESBUILD,
	path.join(engineDir, 'node_modules', 'esbuild-wasm'),
	'esbuild-wasm',
].filter(Boolean);
for (const candidate of esbuildCandidates) {
	try { esbuild = require(candidate); break; }
	catch { /* try next location */ }
}
if (!esbuild) throw new Error('esbuild-wasm 不可用：请安装依赖或设置 PBSIM_ESBUILD');

function findFilesForPath(dir, out = []) {
	for (const file of fs.readdirSync(dir)) {
		const cur = path.join(dir, file);
		const rel = path.relative(engineDir, cur);
		if (rel.includes('node_modules') || rel.startsWith('dist') || rel.includes('/logs') || rel.includes('/databases')) continue;
		if (fs.statSync(cur).isDirectory()) {
			findFilesForPath(cur, out);
		} else if (file.endsWith('.ts') && !file.endsWith('.d.ts') && !file.includes('global-types')) {
			out.push(rel);
		}
	}
	return out;
}

function copyDataJSON(dir) {
	for (const f of fs.readdirSync(dir)) {
		const cur = path.join(dir, f);
		const rel = path.relative(engineDir, cur);
		if (fs.statSync(cur).isDirectory()) {
			copyDataJSON(cur);
		} else if (f.endsWith('.json')) {
			const dest = path.join(distDir, rel);
			// 不用 fs.copyFileSync：Windows 上 copyfile 直接打开目标文件，
			// 刚编译出的 dist 被杀毒/索引服务占用时会 EBUSY 且原地重试无解。
			buildEnv.copyFileResilient(cur, dest);
		}
	}
}

async function main() {
	const entryPoints = findFilesForPath(engineDir);
	console.log(`[build] engine: ${engineDir}`);
	console.log(`[build] ${entryPoints.length} TypeScript entries`);

	process.chdir(engineDir);
	try {
		await esbuild.build({
			entryPoints,
			outdir: './dist',
			outbase: '.',
			format: 'cjs',
			target: 'es2020',
			platform: 'node',
			tsconfig: './tsconfig.json',
			sourcemap: false,
			logLevel: 'warning',
			absWorkingDir: engineDir,
		});
	} finally {
		// esbuild-wasm 会 spawn 一个 unref 的 `node bin/esbuild --service` 长驻进程。
		// 不显式停掉，它可能继续持有引擎目录/esbuild.wasm，随后的复制与打包容易撞锁。
		if (typeof esbuild.stop === 'function') {
			try { await esbuild.stop(); } catch { /* 服务已退出 */ }
		}
	}

	console.log('[build] copying data JSON...');
	copyDataJSON(path.join(engineDir, 'data'));

	const cfgExample = path.join(engineDir, 'config', 'config-example.js');
	const cfgDest = path.join(distDir, 'config', 'config-example.js');
	buildEnv.copyFileResilient(cfgExample, cfgDest);

	const entry = path.join(distDir, 'sim', 'index.js');
	if (!fs.existsSync(entry)) throw new Error(`build produced no entry: ${entry}`);
	console.log(`[build] OK -> ${entry}`);
}

main().catch(err => {
	console.error('[build] FAILED');
	console.error(err);
	process.exit(1);
});
