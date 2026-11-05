'use strict';
/**
 * Preload: exposes the engine RPC and the app-level settings / engine-manager
 * APIs to the page as `window.pbsim.*`. The renderer keeps no Node access.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pbsim', {
	rpc: (method, params) => ipcRenderer.invoke('pbsim:rpc', { method, params: params || {} }),
	app: (method, params) => ipcRenderer.invoke('pbsim:app', { method, params: params || {} }),
	onEngineProgress: callback => {
		const listener = (_event, data) => callback(data);
		ipcRenderer.on('pbsim:engine:progress', listener);
		return () => ipcRenderer.removeListener('pbsim:engine:progress', listener);
	},
});
