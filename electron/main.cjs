'use strict';
/**
 * Electron main process.
 *
 * Replaces the dev HTTP server: the engine-host bridge lives here, exposed to
 * the renderer over IPC, and the UI is served from an internal `app://` scheme
 * instead of a localhost port.
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, dialog, ipcMain, protocol, shell } = require('electron');

const { createEngineHost, createInProcessHost } = require('../app/bridge.cjs');
const { createEngineManager } = require('./engine-manager.cjs');

const IS_OHOS = process.platform === 'ohos' || !!process.versions.ohos;
const PUBLIC = path.join(__dirname, '..', 'app', 'public');
const APP_ORIGIN = 'app://local';
const INDEX = `${APP_ORIGIN}/index.html`;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
};

// Must run before app is ready.
protocol.registerSchemesAsPrivileged([{
	scheme: 'app',
	privileges: { standard: true, secure: true, supportFetchAPI: true },
}]);

let win = null;
let host = null;
let manager = null;

/**
 * Locate the external engine directory.
 *
 * Windows/Linux packaging puts it in resources/engine. A HarmonyOS HAP keeps
 * the Electron app under resfile/resources/app, so the engine may land next to
 * the app or one level up; probe a few candidates instead of assuming one.
 * PBSIM_ENGINE always wins, which is also the documented way to swap the
 * engine data without rebuilding the package.
 */
function engineCandidates() {
	const list = [];
	// The settings file wins: the user may have relocated the engine at runtime.
	if (manager) list.push(manager.engineDir());
	if (process.env.PBSIM_ENGINE) list.push(path.resolve(process.env.PBSIM_ENGINE));
	if (app.isPackaged) {
		if (typeof process.resourcesPath === 'string') {
			list.push(path.join(process.resourcesPath, 'engine'));
			list.push(path.join(process.resourcesPath, 'app', 'engine'));
		}
		list.push(path.join(__dirname, '..', 'engine'));
		list.push(path.join(__dirname, '..', '..', 'engine'));
		list.push(path.join(__dirname, '..', '..', '..', 'engine'));
	} else {
		list.push(path.join(__dirname, '..', 'pokemon-showdown-master'));
	}
	return list;
}

function engineDir() {
	const candidates = engineCandidates();
	const found = candidates.find(p => fs.existsSync(path.join(p, 'dist', 'sim', 'index.js')));
	if (!found) console.error('[pbsim] engine not found, tried:', candidates);
	return found || candidates[0];
}

/**
 * HarmonyOS cannot reliably re-exec the HAP binary as Node, so run the engine
 * in the main process there. PBSIM_HOST_MODE=child|inproc overrides this.
 */
function createHost() {
	const mode = process.env.PBSIM_HOST_MODE;
	const useChild = mode === 'child' || (mode !== 'inproc' && !IS_OHOS);
	return useChild
		? createEngineHost({ engineDir: engineDir() })
		: createInProcessHost({ engineDir: engineDir() });
}

function serveAppScheme() {
	protocol.handle('app', async request => {
		let rel;
		try {
			rel = decodeURIComponent(new URL(request.url).pathname);
		} catch {
			return new Response('bad request', { status: 400 });
		}
		if (!rel || rel === '/') rel = '/index.html';
		const file = path.normalize(path.join(PUBLIC, rel));
		if (!file.startsWith(PUBLIC + path.sep)) {
			return new Response('forbidden', { status: 403 });
		}
		try {
			const data = await fs.promises.readFile(file);
			return new Response(data, {
				headers: { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' },
			});
		} catch {
			return new Response('not found', { status: 404 });
		}
	});
}

function createWindow() {
	win = new BrowserWindow({
		width: 1360,
		height: 900,
		minWidth: 1080,
		minHeight: 640,
		title: '宝可梦对战沙盘',
		backgroundColor: '#eef1f5',
		autoHideMenuBar: true,
		show: false,
		webPreferences: {
			preload: path.join(__dirname, 'preload.cjs'),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});

	win.once('ready-to-show', () => win.show());
	win.on('closed', () => { win = null; });

	// Some OHOS WebEngine builds do not expose custom schemes. Fall back to a
	// plain file:// load; the preload still provides window.pbsim.rpc.
	let loadFallback = false;
	win.webContents.on('did-fail-load', (_event, code, desc, url) => {
		if (loadFallback || !/^app:/.test(url || '')) return;
		loadFallback = true;
		console.warn(`[pbsim] app:// load failed (${code} ${desc}), falling back to loadFile`);
		win.loadFile(path.join(PUBLIC, 'index.html'));
	});

	// Keep external links out of the app window.
	win.webContents.setWindowOpenHandler(({ url }) => {
		if (/^https?:/.test(url)) shell.openExternal(url);
		return { action: 'deny' };
	});

	win.loadURL(INDEX);
}

function rpcHandler() {
	ipcMain.handle('pbsim:rpc', async (_event, payload) => {
		const method = payload && typeof payload.method === 'string' ? payload.method : '';
		if (!method) return { ok: false, error: 'invalid rpc method' };
		try {
			return { ok: true, result: await host.rpcQueued(method, payload.params || {}) };
		} catch (err) {
			return { ok: false, error: err.message };
		}
	});
}

/** Push long-running engine-operation progress to every renderer. */
function broadcastProgress(data) {
	for (const window of BrowserWindow.getAllWindows()) {
		if (!window.isDestroyed()) window.webContents.send('pbsim:engine:progress', data);
	}
}

/**
 * A relocated or updated engine must be loaded by a fresh host process:
 * the host caches `require(dist/sim/index.js)` for its whole lifetime.
 */
async function restartHost() {
	if (host) {
		try { await Promise.resolve(host.close()); } catch { /* already gone */ }
	}
	host = createHost();
	try {
		const probe = await host.rpcQueued('probe');
		return { ok: true, engineVersion: probe.engineVersion, engineDir: host.engineDir };
	} catch (err) {
		return { ok: false, error: err.message };
	}
}

function registerAppIpc() {
	ipcMain.handle('pbsim:app', async (event, payload) => {
		const { method, params = {} } = payload || {};
		try {
			switch (method) {
				case 'getEngineInfo':
					return { ok: true, result: manager.getInfo() };
				case 'chooseEngineDir': {
					const senderWindow = BrowserWindow.fromWebContents(event.sender);
					return { ok: true, result: await manager.chooseDir(senderWindow) };
				}
				case 'moveEngine': {
					const result = await manager.moveEngine(params.dir);
					if (result.moved) result.hostRestart = await restartHost();
					return { ok: true, result };
				}
				case 'checkEngineUpdate':
					return { ok: true, result: await manager.checkUpdate() };
				case 'updateEngine': {
					const result = await manager.updateEngine();
					if (result.updated) result.hostRestart = await restartHost();
					return { ok: true, result };
				}
				default:
					return { ok: false, error: `unknown app method: ${method}` };
			}
		} catch (err) {
			console.error(`[pbsim] app.${method} failed:`, err);
			return { ok: false, error: err.message || String(err) };
		}
	});
}

if (!app.requestSingleInstanceLock()) {
	app.quit();
} else {
	app.on('second-instance', () => {
		if (!win) return;
		if (win.isMinimized()) win.restore();
		win.focus();
	});

	app.whenReady().then(() => {
		app.setAppUserModelId('local.pokemon.battlesim');
		manager = createEngineManager({
			userDataPath: app.getPath('userData'),
			resourcesPath: app.isPackaged ? process.resourcesPath : null,
			projectRoot: path.join(__dirname, '..'),
			buildScript: path.join(__dirname, '..', 'tools', 'build-engine.cjs'),
			esbuildDir: app.isPackaged
				? path.join(process.resourcesPath, 'engine-build', 'esbuild-wasm')
				: path.join(__dirname, '..', 'node_modules', 'esbuild-wasm'),
			execPath: process.execPath,
			dialog,
			onProgress: broadcastProgress,
		});
		host = createHost();
		console.log(`[pbsim] platform=${process.platform} host=${host.mode} engine=${host.engineDir}`);
		serveAppScheme();
		rpcHandler();
		registerAppIpc();
		createWindow();

		app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
	});

	app.on('window-all-closed', () => {
		if (process.platform !== 'darwin') app.quit();
	});

	app.on('before-quit', () => { if (host) host.close(); });
}
