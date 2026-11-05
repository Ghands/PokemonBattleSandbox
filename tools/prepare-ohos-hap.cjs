#!/usr/bin/env node
'use strict';
/**
 * Prepare a copy of the HarmonyOS Electron base project (ohos_hap) for
 * @electron-ohos/electron-builder.
 *
 * The upstream base project ships with:
 *  - a signingConfigs block written by DevEco (its bundleName clashes with
 *    our appId and makes hvigor fail),
 *  - ACL-restricted permissions that require a special signing profile,
 *  - the template's own app name/bundle name.
 *
 * We never edit the downloaded original: everything happens on a working
 * copy under .ohos-build/ohos_hap.
 */

const fs = require('fs');
const path = require('path');

const ACL_PERMISSIONS = [
	'ohos.permission.READ_WRITE_DESKTOP_DIRECTORY',
	'ohos.permission.FILE_ACCESS_PERSIST',
	'ohos.permission.READ_PASTEBOARD',
];

function blockEnd(text, openIdx, open, close) {
	let depth = 0;
	for (let i = openIdx; i < text.length; i++) {
		if (text[i] === open) depth++;
		else if (text[i] === close) {
			depth--;
			if (depth === 0) return i + 1;
		}
	}
	return -1;
}

function clearSigningConfigs(text) {
	// JSON5 allows both `signingConfigs:` and `"signingConfigs":`.
	const m = /["']?signingConfigs["']?\s*:\s*\[/.exec(text);
	if (!m) return { text, changed: false };
	const open = text.indexOf('[', m.index);
	const end = blockEnd(text, open, '[', ']');
	if (end < 0) return { text, changed: false };
	return { text: text.slice(0, open) + '[]' + text.slice(end), changed: true };
}

function replaceJsonValue(text, key, value) {
	const re = new RegExp(`((?:"${key}"|${key})\\s*:\\s*)"[^"]*"`);
	if (!re.test(text)) return { text, changed: false };
	return { text: text.replace(re, `$1"${value}"`), changed: true };
}

function removeAclPermissions(text) {
	let changed = false;
	for (const name of ACL_PERMISSIONS) {
		let idx = text.indexOf(name);
		while (idx >= 0) {
			const open = text.lastIndexOf('{', idx);
			if (open < 0) break;
			const end = blockEnd(text, open, '{', '}');
			if (end < 0) break;
			text = text.slice(0, open) + text.slice(end);
			changed = true;
			idx = text.indexOf(name);
		}
	}
	if (changed) {
		// Removing whole permission objects leaves their separators behind.
		// Normalise until stable: collapse repeated commas, drop leading and
		// trailing commas. JSON5 tolerates trailing commas but we still emit
		// clean JSON so the result can be parsed by plain tooling too.
		let prev;
		do {
			prev = text;
			text = text.replace(/,\s*,+/g, ',');
			text = text.replace(/\[\s*,/g, '[');
			text = text.replace(/,\s*(?=[\]}])/g, '');
		} while (text !== prev);
	}
	return { text, changed };
}

function replaceLabel(text, label) {
	let doc;
	try { doc = JSON.parse(text); } catch { return { text, changed: false }; }
	const entry = doc.string && doc.string.find(s => s.name === 'EntryAbility_label');
	if (!entry) return { text, changed: false };
	entry.value = label;
	return { text: JSON.stringify(doc, null, 2) + '\n', changed: true };
}

function edit(file, fn) {
	if (!fs.existsSync(file)) return false;
	const before = fs.readFileSync(file, 'utf8');
	const r = fn(before);
	if (r.changed && r.text !== before) fs.writeFileSync(file, r.text);
	return r.changed;
}

/**
 * @param {{source:string, dest:string, bundle:string, label?:string}} opts
 */
function prepareOhosHap(opts) {
	const source = path.resolve(opts.source);
	const dest = path.resolve(opts.dest);
	if (!fs.existsSync(path.join(source, 'AppScope', 'app.json5'))) {
		throw new Error(`不是有效的鸿蒙底座工程（缺少 AppScope/app.json5）: ${source}`);
	}

	fs.rmSync(dest, { recursive: true, force: true });
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.cpSync(source, dest, { recursive: true });

	const result = {
		signingConfigs: edit(path.join(dest, 'build-profile.json5'), clearSigningConfigs),
		bundleName: edit(path.join(dest, 'AppScope', 'app.json5'),
			t => replaceJsonValue(t, 'bundleName', opts.bundle)),
		acl: edit(path.join(dest, 'web_engine', 'src', 'main', 'module.json5'), removeAclPermissions),
		label: edit(path.join(dest, 'electron', 'src', 'main', 'resources', 'zh_CN', 'element', 'string.json'),
			t => replaceLabel(t, opts.label || '宝可梦对战沙盘')),
	};
	return { dest, result };
}

module.exports = {
	prepareOhosHap, clearSigningConfigs, replaceJsonValue,
	removeAclPermissions, replaceLabel, ACL_PERMISSIONS,
};

if (require.main === module) {
	const argv = process.argv.slice(2);
	const get = k => {
		const i = argv.indexOf(k);
		return i >= 0 ? argv[i + 1] : undefined;
	};
	const source = get('--source');
	const dest = get('--dest');
	if (!source || !dest) {
		console.error('用法: node tools/prepare-ohos-hap.cjs --source <ohos_hap> --dest <工作副本> [--bundle <appId>] [--label <名称>]');
		process.exit(2);
	}
	const r = prepareOhosHap({
		source, dest,
		bundle: get('--bundle') || 'local.pokemon.battlesim',
		label: get('--label'),
	});
	console.log('已准备底座工程:', r.dest, JSON.stringify(r.result));
}
