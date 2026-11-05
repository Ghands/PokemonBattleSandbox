#!/usr/bin/env node
'use strict';
/**
 * Build a HarmonyOS PC HAP/APP for this Electron project.
 *
 * This is the real build driver; build-ohos.sh / build-ohos.bat are thin
 * wrappers. It is pure Node so it behaves identically on HarmonyOS PC,
 * Linux, macOS and Windows (with DevEco Studio installed).
 *
 * Prerequisites (see HELP below):
 *   - DevEco Studio 5.x or Command Line Tools for HarmonyOS
 *   - JDK 17+
 *   - the ohos_hap base project from the Electron-for-OHOS release package
 *   - optionally a Huawei signing certificate/profile for a signed HAP
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
const has = f => argv.includes(f);

const DRY = has('--dry-run');
const CLEAN = has('--clean');
const SKIP_ENGINE = has('--skip-engine');
const TARGET_APP = has('--app');
const HELP = has('--help') || has('-h');

const { buildOhosConfig, DEFAULT_APP_ID, REQUIRED_ENV } = require('./ohos-config.cjs');
const { prepareOhosHap } = require('./prepare-ohos-hap.cjs');

const HELP_TEXT = `
用法: node tools/build-ohos.cjs [选项]

选项:
  --dry-run       只检查环境并打印构建计划，不下载/不写文件/不打包
  --clean         先清空 release-ohos 输出目录
  --app           打 APP 包（默认打 HAP）
  --skip-engine   跳过引擎构建与依赖检查（已有 dist 时用）
  -h, --help      显示本说明

必需环境变量（也可用 DEVECO_HOME 自动探测前三个）:
  OHOS_HVIGORW_PATH   DevEco/命令行工具里的 hvigor/bin 目录
  OHOS_OHPM_PATH      ohpm/bin 目录
  OHOS_SDK_PATH       HarmonyOS SDK 目录
  OHOS_HAP_PATH       鸿蒙底座工程 ohos_hap 目录（Electron-for-OHOS 发布包内）

可选环境变量:
  DEVECO_HOME / OHOS_HOME   DevEco 安装根目录，用于自动探测上面三个路径
  OHOS_APP_ID           HAP 的 bundleName，默认 ${DEFAULT_APP_ID}
  OHOS_TARGET=hap|app   同 --app
  OHOS_CERT_PATH        签名证书 .cer
  OHOS_PROFILE          签名 profile .p7b
  OHOS_KEY_ALIAS        密钥别名
  OHOS_KEY_PWD          别名密码（也可用 OH_KEY_PWD）
  OHOS_STORE_FILE       密钥库 .p12
  OHOS_STORE_PWD        密钥库密码（也可用 OH_STORE_PWD）

说明:
  - 不提供签名信息时产出未签名 HAP，只能用 DevEco 自动签名或自行调试；
    要安装到真机/上架，需在 AppGallery Connect 申请证书与 profile。
  - 底座工程 ohos_hap 不在本仓库内（约数百 MB），需从 Electron for
    OpenHarmony 发布包中获取，脚本会复制一份到 .ohos-build/ 再整理。
  - 产物在 release-ohos/，安装: hdc app install <xxx.hap>
`;

function log(...a) { console.log('[ohos]', ...a); }
function warn(...a) { console.warn('[ohos] 警告:', ...a); }
function fail(msg) { console.error('[ohos] 错误:', msg); process.exit(1); }

function run(cmd, args, opts = {}) {
	log(DRY ? '$ [dry-run]' : '$', cmd, args.join(' '));
	if (DRY) return { status: 0 };
	const r = spawnSync(cmd, args, {
		cwd: ROOT,
		stdio: 'inherit',
		shell: process.platform === 'win32',
		...opts,
	});
	if (r.error) throw r.error;
	return r;
}

function mustRun(cmd, args, opts) {
	const r = run(cmd, args, opts);
	if (r.status !== 0) fail(`${cmd} 退出码 ${r.status}`);
}

function checkNode() {
	const major = Number(process.versions.node.split('.')[0]);
	if (major < 22) fail(`需要 Node.js >= 22.18，当前 ${process.version}`);
	log('Node', process.version);
}

function checkJava() {
	const r = spawnSync('java', ['-version'], { encoding: 'utf8' });
	const text = `${r.stderr || ''}${r.stdout || ''}`;
	if (r.error || r.status !== 0) {
		const msg = '未找到 java（鸿蒙打包需要 JDK 17+）';
		if (DRY) warn(msg); else fail(msg);
		return;
	}
	const m = /version\s+"(\d+)(?:\.(\d+))?/.exec(text);
	let major = m ? Number(m[1]) : 0;
	if (major === 1) major = Number(m[2]); // "1.8.0_xxx"
	if (major && major < 17) {
		const msg = `JDK 版本过低（${major}），需要 17+`;
		if (DRY) warn(msg); else fail(msg);
	} else {
		log('JDK major', major || 'unknown');
	}
}

function autodetectDevEco() {
	const home = os.homedir();
	const roots = [
		process.env.DEVECO_HOME,
		process.env.OHOS_HOME,
		process.env.HOS_SDK_HOME,
		path.join(home, 'DevEco Studio'),
		path.join(home, 'deveco'),
		path.join(home, 'command-line-tools'),
	].filter(Boolean);
	for (const root of roots) {
		const hvigor = path.join(root, 'tools', 'hvigor', 'bin');
		const sdk = path.join(root, 'sdk');
		if (!fs.existsSync(hvigor) || !fs.existsSync(sdk)) continue;
		if (!process.env.OHOS_HVIGORW_PATH) process.env.OHOS_HVIGORW_PATH = hvigor;
		if (!process.env.OHOS_OHPM_PATH) {
			const ohpm = path.join(root, 'tools', 'ohpm', 'bin');
			if (fs.existsSync(ohpm)) process.env.OHOS_OHPM_PATH = ohpm;
		}
		if (!process.env.OHOS_SDK_PATH) process.env.OHOS_SDK_PATH = sdk;
		log('自动探测 DevEco:', root);
		return;
	}
}

function checkEnv() {
	autodetectDevEco();
	const missing = REQUIRED_ENV.filter(k => !process.env[k]);
	if (missing.length) {
		const msg = `缺少环境变量: ${missing.join(', ')}`;
		if (DRY) {
			warn(msg + '（--dry-run 用占位值继续）');
			for (const k of missing) process.env[k] = `<请设置 ${k}>`;
		} else {
			fail(msg + '\n' + HELP_TEXT);
		}
	}
	const hap = process.env.OHOS_HAP_PATH;
	if (hap && !hap.startsWith('<') && !fs.existsSync(path.join(hap, 'AppScope', 'app.json5'))) {
		const msg = `OHOS_HAP_PATH 不是有效的底座工程: ${hap}`;
		if (DRY) warn(msg); else fail(msg);
	}
}

function ensureEngine() {
	const dist = path.join(ROOT, 'pokemon-showdown-master', 'dist', 'sim', 'index.js');
	if (!fs.existsSync(dist)) {
		if (SKIP_ENGINE) warn('引擎 dist 缺失，但指定了 --skip-engine');
		else mustRun('npm', ['run', 'build:engine']);
	} else {
		log('引擎 dist 已存在');
	}
	const cha = path.join(ROOT, 'pokemon-showdown-master', 'node_modules', 'ts-chacha20');
	if (!fs.existsSync(cha)) {
		if (SKIP_ENGINE) warn('ts-chacha20 缺失，但指定了 --skip-engine');
		else mustRun('npm', ['i', '--prefix', 'pokemon-showdown-master', '--omit=dev', '--no-save', 'ts-chacha20']);
	}
}

function ensureIcon() {
	if (!fs.existsSync(path.join(ROOT, 'build', 'icon.png'))) {
		mustRun(process.execPath, ['tools/make-icon.cjs']);
	}
}

function prepareBase() {
	const source = process.env.OHOS_HAP_PATH;
	const dest = path.join(ROOT, '.ohos-build', 'ohos_hap');
	if (!source || source.startsWith('<') || !fs.existsSync(source)) {
		if (DRY) {
			log('将整理底座工程 ->', dest, '（需先设置 OHOS_HAP_PATH）');
			return;
		}
		fail('底座工程不存在，无法整理');
	}
	const bundle = process.env.OHOS_APP_ID || DEFAULT_APP_ID;
	if (!DRY) {
		const r = prepareOhosHap({ source, dest, bundle, label: '宝可梦对战沙盘' });
		log('底座工程已整理:', r.dest, JSON.stringify(r.result));
	} else {
		log('将整理底座工程 ->', dest, `(bundleName=${bundle})`);
	}
	// The builder config always consumes the working copy, never the original.
	process.env.OHOS_HAP_PATH = dest;
}

function ensureBuilder() {
	const cli = path.join(ROOT, 'node_modules', '@electron-ohos', 'electron-builder', 'cli.js');
	if (fs.existsSync(cli)) {
		log('@electron-ohos/electron-builder 已安装');
		return;
	}
	log(DRY ? '将安装 @electron-ohos/electron-builder' : '安装 @electron-ohos/electron-builder（首次构建需要）…');
	mustRun('npm', ['install', '--no-save', '--no-audit', '--no-fund', '@electron-ohos/electron-builder@26.8.8']);
}

function main() {
	if (HELP) { console.log(HELP_TEXT); return; }
	if (TARGET_APP) process.env.OHOS_TARGET = 'app';

	log(DRY ? '=== dry-run：只检查，不执行构建 ===' : '=== 开始鸿蒙 PC 打包 ===');
	checkNode();
	checkJava();
	checkEnv();
	if (!SKIP_ENGINE) ensureEngine();
	ensureIcon();
	prepareBase();
	ensureBuilder();

	// Validate the generated config before invoking hvigor.
	const cfg = buildOhosConfig(process.env, ROOT);
	log('配置摘要:', JSON.stringify({
		appId: cfg.appId,
		target: cfg.ohos.target,
		asar: cfg.asar,
		npmRebuild: cfg.npmRebuild,
		engineResources: cfg.extraResources.length,
		signed: !!cfg.ohos.certPath,
		baseProject: cfg.ohos.ohosHapPath,
	}));

	if (CLEAN && !DRY) {
		fs.rmSync(path.join(ROOT, 'release-ohos'), { recursive: true, force: true });
		log('已清空 release-ohos');
	}

	mustRun('npx', ['electron-builder-ohos', '--ohos', '--config', 'electron-builder.ohos.js']);

	const out = path.join(ROOT, 'release-ohos');
	if (fs.existsSync(out)) {
		log('产物目录:', out);
		for (const f of fs.readdirSync(out)) log('   ', f);
	}
	log(DRY ? 'dry-run 完成（未实际打包）' : '完成。安装: hdc app install <release-ohos 内的 .hap>');
}

try {
	main();
} catch (err) {
	fail(err.message);
}
