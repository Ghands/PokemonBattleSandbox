#!/usr/bin/env node
/**
 * Dev server for the battle sandbox UI (browser mode).
 *
 * - Serves app/public as static files.
 * - Bridges POST /api/rpc { method, params } to the engine-host subprocess
 *   via app/bridge.cjs — the same bridge the Electron main process uses.
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const { createEngineHost } = require('./bridge.cjs');

const PUBLIC = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 8931);

const host = createEngineHost();
const rpcQueued = host.rpcQueued;

const MIME = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
};

function serveStatic(req, res) {
	let url = decodeURIComponent(req.url.split('?')[0]);
	if (url === '/') url = '/index.html';
	const file = path.normalize(path.join(PUBLIC, url));
	if (!file.startsWith(PUBLIC)) {
		res.writeHead(403).end('forbidden');
		return;
	}
	fs.readFile(file, (err, data) => {
		if (err) {
			res.writeHead(404).end('not found');
			return;
		}
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
		res.end(data);
	});
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = '';
		req.on('data', chunk => { data += chunk; });
		req.on('end', () => {
			if (!data) return resolve({});
			try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
		});
		req.on('error', reject);
	});
}

const server = http.createServer(async (req, res) => {
	if (req.method === 'POST' && req.url === '/api/rpc') {
		try {
			const { method, params } = await readBody(req);
			const result = await rpcQueued(method, params);
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: true, result }));
		} catch (err) {
			res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ ok: false, error: err.message }));
		}
		return;
	}
	serveStatic(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`battle sandbox UI: http://127.0.0.1:${PORT}`);
	console.log(`engine: ${host.engineDir}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => { host.close(); process.exit(0); });
}
