'use strict';
/**
 * HarmonyOS PC packaging config for @electron-ohos/electron-builder.
 *
 * Kept in a standalone file (not package.json) on purpose: the OHOS fork is
 * derived from electron-builder 28.x, where `win` / `nsis` / `portable` keys
 * no longer exist. Mixing the Windows config into it triggers schema errors.
 * All machine-specific paths come from environment variables so no absolute
 * path from the developer's machine is baked into the repo.
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_APP_ID = 'local.pokemon.battlesim';

const REQUIRED_ENV = [
	'OHOS_HVIGORW_PATH',
	'OHOS_OHPM_PATH',
	'OHOS_SDK_PATH',
	'OHOS_HAP_PATH',
];

function optional(env, key) {
	const v = env[key];
	return v === undefined || v === '' ? undefined : String(v);
}

function required(env, key) {
	const v = optional(env, key);
	if (!v) {
		throw new Error(`缺少环境变量 ${key}，请在 build-ohos 前设置（见 build-ohos.sh 顶部说明）`);
	}
	return v;
}

/**
 * @param {object} env  process.env (injectable for tests / dry-run)
 * @param {string} root project root
 */
function buildOhosConfig(env, root) {
	env = env || process.env;
	root = root || path.join(__dirname, '..');
	const pkg = require(path.join(root, 'package.json'));

	// The engine stays external: copied into resources/engine instead of being
	// bundled into the app. Replace that directory (or set PBSIM_ENGINE) to
	// update the simulator data without rebuilding the HAP.
	const extraResources = [];
	const push = (from, to) => {
		if (fs.existsSync(path.join(root, from))) {
			extraResources.push({ from, to });
		} else {
			console.warn(`[ohos-config] 资源不存在，已跳过: ${from}`);
		}
	};
	push('pokemon-showdown-master/dist', 'engine/dist');
	push('pokemon-showdown-master/package.json', 'engine/package.json');
	push('pokemon-showdown-master/LICENSE', 'engine/LICENSE');
	push('pokemon-showdown-master/node_modules/ts-chacha20', 'engine/node_modules/ts-chacha20');

	const ohos = {
		target: [env.OHOS_TARGET === 'app' ? 'app' : 'hap'],
		icon: 'build/icon.png',
		hvigorwPath: required(env, 'OHOS_HVIGORW_PATH'),
		ohpmPath: required(env, 'OHOS_OHPM_PATH'),
		sdkPath: required(env, 'OHOS_SDK_PATH'),
		ohosHapPath: required(env, 'OHOS_HAP_PATH'),
	};

	// Signing is optional: without it electron-builder-ohos emits an unsigned
	// HAP. Huawei does not allow self-signed HAPs, so certificate/profile come
	// from AppGallery Connect. All six must be present together.
	const sign = {
		certPath: optional(env, 'OHOS_CERT_PATH'),
		profile: optional(env, 'OHOS_PROFILE'),
		keyAlias: optional(env, 'OHOS_KEY_ALIAS'),
		keyPassword: optional(env, 'OHOS_KEY_PWD') || optional(env, 'OH_KEY_PWD'),
		storeFile: optional(env, 'OHOS_STORE_FILE'),
		storePassword: optional(env, 'OHOS_STORE_PWD') || optional(env, 'OH_STORE_PWD'),
	};
	const provided = Object.entries(sign).filter(([, v]) => v);
	if (provided.length) {
		const missing = Object.entries(sign).filter(([, v]) => !v).map(([k]) => k);
		if (missing.length) throw new Error(`鸿蒙签名配置不完整，缺少: ${missing.join(', ')}`);
		Object.assign(ohos, sign);
	}

	return {
		appId: optional(env, 'OHOS_APP_ID') || DEFAULT_APP_ID,
		productName: 'PokemonBattleSim',
		copyright: (pkg.build && pkg.build.copyright) || '',
		directories: { output: 'release-ohos', buildResources: 'build' },
		asar: false,        // HAP resources live under resfile; asar breaks them
		npmRebuild: false,  // node-gyp has no OHOS support; this app has no native modules
		files: [
			'electron/**/*',
			'app/**/*',
			'engine-host/**/*',
			'package.json',
			'!**/*.map',
			'!**/node_modules/**/{test,__tests__}/**',
		],
		extraResources,
		ohos,
	};
}

module.exports = { buildOhosConfig, DEFAULT_APP_ID, REQUIRED_ENV };
