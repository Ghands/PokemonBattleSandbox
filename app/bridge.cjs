'use strict';
/**
 * Engine bridge: owns the engine-host child process and speaks its
 * newline-delimited JSON protocol.
 *
 * Shared by the dev HTTP server (app/server.cjs) and the Electron main
 * process (electron/main.cjs), so both front ends use the same RPC surface:
 *
 *   rpc(method, params)       -> Promise<result>
 *   rpcQueued(method, params) -> Promise<result>   (serialized)
 *   close()
 *
 * Two transports are provided: a child process (default, also used by the
 * browser dev server) and an in-process host. HarmonyOS HAPs cannot always
 * re-exec their own binary with ELECTRON_RUN_AS_NODE, so the packaged OHOS
 * app uses the in-process transport.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const ROOT = path.join(__dirname, '..');
const HOST = path.join(__dirname, '..', 'engine-host', 'host.cjs');

/**
 * Engine directory resolution order:
 *   1. explicit argument
 *   2. PBSIM_ENGINE env var
 *   3. <resources>/engine  (packaged Electron, externally replaceable)
 *   4. ./pokemon-showdown-master (repo checkout)
 */
function resolveEngineDir(explicit) {
	if (explicit) return path.resolve(explicit);
	if (process.env.PBSIM_ENGINE) return path.resolve(process.env.PBSIM_ENGINE);
	const packed = typeof process.resourcesPath === 'string'
		? path.join(process.resourcesPath, 'engine') : null;
	if (packed && fs.existsSync(path.join(packed, 'dist', 'sim', 'index.js'))) return packed;
	return path.join(ROOT, 'pokemon-showdown-master');
}

function createEngineHost(options = {}) {
	const engineDir = resolveEngineDir(options.engineDir);
	const hostScript = options.hostScript || HOST;

	let child = null;
	let seq = 1;
	let chain = Promise.resolve();
	const pending = new Map();

	function failAll(reason) {
		for (const entry of pending.values()) entry.reject(new Error(reason));
		pending.clear();
	}

	function start() {
		if (child) return child;
		// PBSIM_NODE allows pointing at a standalone node binary when the
		// hosting Electron build does not honour ELECTRON_RUN_AS_NODE.
		const nodeBin = options.nodeBin || process.env.PBSIM_NODE || process.execPath;
		const proc = spawn(nodeBin, [hostScript, '--engine', engineDir], {
			stdio: ['pipe', 'pipe', 'inherit'],
			// Inside Electron, process.execPath is the app binary: this flag makes
			// it behave as plain node so the host script can run.
			env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
		});

		const rl = readline.createInterface({ input: proc.stdout, terminal: false });
		rl.on('line', line => {
			let msg;
			try { msg = JSON.parse(line); } catch { return; }
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			if (msg.ok) entry.resolve(msg.result);
			else entry.reject(new Error(msg.error));
		});

		proc.on('exit', code => {
			if (child === proc) child = null;
			failAll(`engine host exited (${code})`);
		});
		proc.on('error', err => {
			if (child === proc) child = null;
			failAll(`engine host failed: ${err.message}`);
		});
		proc.stdin.on('error', () => { /* handled by exit */ });

		child = proc;
		return proc;
	}

	function rpc(method, params) {
		const proc = start();
		const id = seq++;
		return new Promise((resolve, reject) => {
			pending.set(id, { resolve, reject });
			proc.stdin.write(JSON.stringify({ id, method, params }) + '\n', err => {
				if (!err) return;
				pending.delete(id);
				reject(err);
			});
		});
	}

	function rpcQueued(method, params) {
		const run = chain.then(() => rpc(method, params), () => rpc(method, params));
		chain = run.catch(() => {});
		return run;
	}

	function close() {
		if (!child) return;
		const proc = child;
		child = null;
		try { proc.stdin.end(); } catch { /* already closed */ }
		try { proc.kill(); } catch { /* already dead */ }
	}

	return { engineDir, hostScript, mode: 'child', rpc, rpcQueued, close };
}

/**
 * Run the engine host in the current process. No spawn, no stdio protocol.
 * The engine is pure JS, so this works anywhere Electron's Node layer works.
 */
function createInProcessHost(options = {}) {
	const engineDir = resolveEngineDir(options.engineDir);
	const hostScript = options.hostScript || HOST;

	// host.cjs captures its engine directory at module load time.
	process.env.PBSIM_ENGINE = engineDir;
	const hostMod = require(hostScript);
	if (hostMod.engineDir !== engineDir) {
		throw new Error(`engine host already loaded with ${hostMod.engineDir}`);
	}
	const handle = hostMod.handle;

	let chain = Promise.resolve();
	function rpc(method, params) {
		const run = chain.then(
			() => handle(method, params || {}),
			() => handle(method, params || {}),
		);
		chain = run.catch(() => {});
		return run;
	}
	function close() {
		return handle('shutdown', {}).catch(() => {});
	}
	return { engineDir, hostScript, mode: 'in-process', rpc, rpcQueued: rpc, close };
}

module.exports = { createEngineHost, createInProcessHost, resolveEngineDir };
