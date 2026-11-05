# 宝可梦对战沙盘 · 干净构建包

这个文件夹是**只含自研源码的可分发构建包**。把整个文件夹复制到任意一台联网的 Windows / Linux 机器上，直接运行构建脚本，就能产出 windows / linux × x64 / arm64 的客户端安装包。

**核心约定**：凡是能通过互联网获取的内容，都不放进这个文件夹，而是由脚本在运行时自动下载。

---

## 一、快速开始

```bat
:: Windows
build.bat --os windows --arch x64
build.bat --os all --arch all
build.bat --setup-only          :: 只下载依赖，不打包
```

```bash
# Linux / macOS
chmod +x build.sh build-installer.sh
./build.sh --os linux --arch arm64
./build.sh --os all --arch all
```

第一次运行会依次完成：下载便携 Node.js（仅当系统没有合格 Node）→ `npm install` → 从 GitHub 拉取 Pokemon Showdown 源码 → 编译引擎 `dist` → 补齐 `ts-chacha20`、生成图标 → 调用 `electron-builder` 产出安装包。产物默认在 `release/`。

已经下载过的内容会被复用，第二次运行只做增量检查，不会重复下载。

---

## 二、文件夹里有什么 / 没什么

**随包分发的（约 400 KB，40 个自研文件 + 新增脚本）**

| 路径 | 作用 |
|---|---|
| `bootstrap.cjs` | 引导脚本：下载依赖、准备源码、调用编译脚本 |
| `build.bat` / `build.sh` | 主入口：必要时下载便携 Node，然后运行引导脚本 |
| `build-installer.bat` / `.sh` | 兼容入口，转调主入口 |
| `build-kit.json` / `.node-version` | 下载源与版本配置 |
| `package.json` / `package-lock.json` | 项目配置与依赖锁定清单 |
| `electron/` | 主进程、preload、引擎/数据管理模块 |
| `app/` | 前端界面与桥接层 |
| `engine-host/` | 对战引擎宿主与会话逻辑 |
| `tools/` | 编译脚本：`build-installer.cjs`、`build-engine.cjs`、`make-icon.cjs`，及鸿蒙相关脚本 |
| `spike/` | 回归测试 |
| `build/icon.ico` / `icon.png` | 应用图标（也可由 `tools/make-icon.cjs` 重新生成） |
| 根目录若干 `.bat/.sh/.ps1` | 原有构建/鸿蒙脚本 |

**不随包分发、运行时自动获取的**

| 内容 | 下载/生成方式 | 落点 |
|---|---|---|
| Node.js 运行时 | `curl` + `tar` 下载官方便携包（无合格系统 Node 时） | `.runtime/node/` |
| npm 开发依赖 | `npm install`（electron-builder / electron / esbuild-wasm / jsdom） | `node_modules/` |
| Pokemon Showdown 引擎与数据源码 | GitHub codeload tarball | `pokemon-showdown-master/` |
| 引擎编译产物 | `tools/build-engine.cjs` + esbuild-wasm | `pokemon-showdown-master/dist/` |
| 引擎随机数依赖 `ts-chacha20` | npm 单包下载 | `pokemon-showdown-master/node_modules/` |
| 应用图标 | `tools/make-icon.cjs`（纯 Node 生成） | `build/` |
| Electron / NSIS / 7zip / AppImage 工具链 | electron-builder 自行下载 | 系统缓存目录 |
| 安装包 | 构建产物 | `release/` |

以上目录都已写进 `.gitignore`。要「还原成全新状态」，删掉这些目录再运行即可。

---

## 三、参数

**引导脚本专有参数**（写在 `build.bat` / `build.sh` 后面即可）

| 参数 | 说明 |
|---|---|
| `--ps-ref <ref>` | 固定 Pokemon Showdown 的分支 / 标签 / commit sha，默认 `master` |
| `--npm-registry <url>` | 自定义 npm registry |
| `--force-engine` | 强制重新下载引擎源码 |
| `--force-deps` | 强制重新 `npm install` |
| `--setup-only` | 只准备环境，不执行打包 |
| `--no-mirror` | npm 与 Electron 都走官方源，不用国内镜像 |
| `--dry-run` | 只打印本次会下载/执行的计划，不写任何文件 |
| `--help` | 显示帮助 |

**其余参数原样透传给 `tools/build-installer.cjs`**

| 参数 | 说明 |
|---|---|
| `-p, --os <windows\|linux\|all>` | 目标系统，默认当前系统 |
| `-a, --arch <x64\|arm64\|all>` | 目标架构，默认当前架构 |
| `-t, --target <list>` | 产物类型，如 `nsis,portable` / `tar.gz` / `deb,appimage` |
| `--dir` | 只产免安装目录（最快） |
| `-o, --out <dir>` | 输出目录，默认 `release` |
| `--clean` / `--rebuild-engine` / `--skip-engine` / `--electron-mirror <url>` | 同编译脚本 |

也可以走 npm 别名：`npm run kit:setup`、`npm run dist:all`、`npm run build:installer`。

---

## 四、下载源与可配置项

| 用途 | 默认地址 | 改法 |
|---|---|---|
| npm 依赖 | `https://registry.npmmirror.com` | `build-kit.json` → `npmRegistry`，或 `--npm-registry` |
| 便携 Node | `https://npmmirror.com/mirrors/node/`（失败回退 `nodejs.org`） | Windows: `PBSIM_NODE_MIRROR`；Linux: `PBSIM_NODE_MIRROR`；版本改 `.node-version` 或 `PBSIM_NODE_VERSION` |
| Pokemon Showdown | `smogon/pokemon-showdown @ master` | `build-kit.json` → `pokemonShowdown`，或 `--ps-ref` |
| Electron / NSIS | npmmirror（由 `tools/build-installer.cjs` 设置） | `--no-mirror` 或 `--electron-mirror` |

环境变量：`PBSIM_NODE` 指定引导用的 node 可执行文件；`PBSIM_FORCE_NODE=1` 强制走便携 Node 下载链路（用于离线演练/验证）。

---

## 五、实现要点

- **不改动自研源码的构建逻辑**：`tools/build-installer.cjs` 保持原样，它的前置检查本来就能自动编译引擎 `dist`、补齐 `ts-chacha20`、生成图标；`bootstrap.cjs` 负责把「Node + npm 依赖 + PS 源码」准备好，并提前编译 `dist`。
- **单实例、可重复执行**：每一步都有就绪检测，二次运行不会重复下载；`--force-*` 可强制刷新。
- **Windows 文件锁容错**：引擎 `dist` 提前编译并静置 3 秒再进入打包；若 `electron-builder` 拷贝 `extraResources` 时仍遇到 `EBUSY`/`EPERM`（实时杀毒或索引服务短暂锁定文件），引导脚本会递增等待并自动重试最多 5 次。在 `AppData\Local\Temp` 这类被重点扫描的目录下实测过：前两次分别在不同文件上触发 `EBUSY`，第三次完成打包；普通目录通常一次通过。
- **安全**：GitHub tarball 解压自己实现（USTAR / GNU longname / PAX），过滤 `..`、绝对路径、盘符路径，跳过符号链接；不执行任何远端代码，TypeScript 只由 esbuild-wasm 转译。
- **不下载 Electron 二进制两次**：`npm install` 时设 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`，Electron 按目标架构由 electron-builder 单独下载并缓存。
- **避免宿主干扰**：引导脚本清掉 `ELECTRON_RUN_AS_NODE`，否则 electron-builder 会误判运行环境。
- **跨主机构建**：Windows 主机可交叉打 Linux 包（默认 `tar.gz`）；Linux 主机上同一命令会额外产出 `deb` + `AppImage`。

---

## 六、注意事项

1. 首次构建需要联网，且会下载较多内容（npm 依赖、约 7 MB 的 PS 源码包、各目标架构的 Electron 运行时约 100–160 MB / 架构）。GitHub codeload 在国内可能较慢。
2. `master` 分支上游随时可能变化；若需要可复现构建，在 `build-kit.json` 里把 `ref` 固定成一个 commit sha。实际使用的 sha 会记录在 `.cache/engine-source.json`。
3. 安装包**未做代码签名**，首次运行可能触发 SmartScreen / Gatekeeper 提示。
4. Windows 主机交叉打 Linux 的 `deb` / `rpm` 需要 `fpm`，`AppImage` 需要 Linux 工具链；默认只出解压即用的 `tar.gz`。
5. 引擎或数据位置、更新引擎等功能属于**已打包客户端**里的「设置 → 数据设置」，与这个构建包无关；构建包只负责产出安装包。

---

## 七、验证记录（2026-11-05）

把本文件夹**原样复制**到一个全新的临时目录，从「零依赖、零源码」状态实测：

| 环节 | 结果 |
|---|---|
| `build.bat` 强制下载便携 Node（`PBSIM_FORCE_NODE=1`） | 成功，npmmirror 下载 34 MB → `tar.exe` 解压 → `node v22.22.2` + `npm-cli.js` 可用，退出码 0 |
| `npm install`（npmmirror，跳过 Electron 二进制） | 321 个包，约 1 分钟 |
| GitHub 拉取 `smogon/pokemon-showdown` | 提交 `16db150`，codeload tarball 解压 1057 个文件，`zh-cn` 中文文本齐全 |
| `tools/build-engine.cjs` 编译 | 521 个 TS 入口 → `dist/sim/index.js`，dist 共 554 文件 / 42.5 MB |
| `ts-chacha20` 自动补齐 | 1.2.0，12 个文件 |
| `build.bat --os windows --arch x64` 完整打包 | **退出码 0**；`Setup-0.1.0-x64.exe` 122.6 MB、`Portable-0.1.0-x64.exe` 110.4 MB、`win-unpacked/` |
| 包内资源核对 | `engine/dist/sim/index.js`、`ts-chacha20`、`esbuild.wasm`、`engine-manager.cjs`、`index.html` 等在两个安装包中均存在 |
| `build.bat --dry-run --os all --arch all` / `--help` | 参数透传正确，退出码 0 |
| 回归测试 `spike/build-kit-test.cjs` | 13 项全过（解压器、路径穿越防护、参数解析、配置校验） |
| 源码保真 | 37 个自研文件与原项目字节一致，仅 3 个入口文件按构建包需要做了适配 |

验证是在副本上进行的，**交付的这个文件夹保持「零下载内容」状态**（没有 `node_modules`、`pokemon-showdown-master`、`.runtime`、`.cache`、`release`）。
