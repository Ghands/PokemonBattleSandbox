<#
.SYNOPSIS
    宝可梦对战沙盘 —— Windows 打包脚本。

.DESCRIPTION
    在本目录（项目根目录）执行，依次完成：
      1. 检查 Node.js / npm 版本
      2. 安装项目依赖（首次构建）
      3. 构建 Pokemon Showdown 引擎 dist（缺失时）
      4. 检查引擎运行时依赖 ts-chacha20
      5. 生成应用图标（缺失时）
      6. 调用 electron-builder 产出 Windows 应用

    产物全部写入 .\release\ ：
      release\win-unpacked\                  免安装目录，双击 PokemonBattleSim.exe 即可运行
      release\PokemonBattleSim-Setup-*.exe   NSIS 安装包
      release\PokemonBattleSim-Portable-*.exe 便携单文件版

.PARAMETER Dir
    只生成免安装目录（最快，不需要下载 NSIS，产物可直接运行）。

.PARAMETER Clean
    打包前删除旧的 release 目录。

.PARAMETER RebuildEngine
    强制重新构建引擎 dist（修改了引擎源码或数据后使用）。

.PARAMETER NoMirror
    不使用国内镜像（默认走 npmmirror，海外网络可加此参数）。

.PARAMETER Arch
    目标架构，默认 x64。

.EXAMPLE
    .\build-win.ps1
    .\build-win.ps1 -Clean
    .\build-win.ps1 -Dir
    .\build-win.ps1 -RebuildEngine -Clean
    .\build-win.ps1 -Arch arm64        # ARM64 版（也可直接运行 build-win-arm64.bat）
#>
[CmdletBinding()]
param(
    [switch]$Dir,
    [switch]$Clean,
    [switch]$RebuildEngine,
    [switch]$NoMirror,
    [ValidateSet('x64', 'arm64', 'ia32')]
    [string]$Arch = 'x64'
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Write-Step {
    param([string]$Text)
    Write-Host ''
    Write-Host "==> $Text" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Text)
    Write-Host "    $Text" -ForegroundColor Green
}

function Fail {
    param([string]$Text)
    Write-Host ''
    Write-Host "!! $Text" -ForegroundColor Red
    exit 1
}

function Invoke-Checked {
    param([string]$Command, [string[]]$CommandArgs)
    & $Command @CommandArgs
    if ($LASTEXITCODE -ne 0) {
        Fail "命令执行失败：$Command $($CommandArgs -join ' ')（退出码 $LASTEXITCODE）"
    }
}

Write-Host ''
Write-Host '========================================' -ForegroundColor DarkGray
Write-Host ' 宝可梦对战沙盘 · Windows 打包' -ForegroundColor White
Write-Host '========================================' -ForegroundColor DarkGray

# ---------------------------------------------------------------- 环境检查
Write-Step '检查运行环境'

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail '未找到 Node.js。请安装 Node.js 22.18 或更高版本：https://nodejs.org/'
}
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    Fail '未找到 npm。请重新安装 Node.js（安装包自带 npm）。'
}

$nodeVersion = (& node -p "process.versions.node").Trim()
if ([version]$nodeVersion -lt [version]'22.18.0') {
    Fail "Node.js 版本过低：v$nodeVersion，需要 >= 22.18.0"
}
Write-Ok "Node.js v$nodeVersion"

if (-not $NoMirror) {
    if (-not $env:ELECTRON_MIRROR) {
        $env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
    }
    if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
        $env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
    }
    Write-Ok 'Electron / NSIS 使用国内镜像下载（-NoMirror 可关闭）'
}

if ($Clean -and (Test-Path -LiteralPath 'release')) {
    Write-Step '清理旧的 release 目录'
    Remove-Item -LiteralPath 'release' -Recurse -Force
    Write-Ok '已删除 release'
}

# ---------------------------------------------------------------- 依赖安装
Write-Step '检查项目依赖'

if (-not (Test-Path -LiteralPath 'node_modules\electron-builder')) {
    Write-Host '    首次构建需要安装依赖，请耐心等待…'
    Write-Host '    若 npm 下载很慢，可先执行：npm config set registry https://registry.npmmirror.com' -ForegroundColor DarkGray
    Invoke-Checked 'npm' @('install', '--no-audit', '--no-fund')
}
Write-Ok 'electron / electron-builder 已就绪'

# ---------------------------------------------------------------- 引擎构建
Write-Step '检查对战引擎'

$engineDir = Join-Path $PSScriptRoot 'pokemon-showdown-master'
if (-not (Test-Path -LiteralPath $engineDir)) {
    Fail "缺少引擎目录：$engineDir"
}

$engineEntry = Join-Path $engineDir 'dist\sim\index.js'
if ($RebuildEngine -or -not (Test-Path -LiteralPath $engineEntry)) {
    Write-Host '    构建引擎 dist（esbuild-wasm，约 1-3 分钟）…'
    Invoke-Checked 'npm' @('run', 'build:engine')
}
Write-Ok '引擎 dist 已就绪'

$engineDep = Join-Path $engineDir 'node_modules\ts-chacha20'
if (-not (Test-Path -LiteralPath $engineDep)) {
    Write-Host '    安装引擎运行时依赖（ts-chacha20）…'
    Invoke-Checked 'npm' @('install', '--prefix', $engineDir, '--omit=dev', '--no-audit', '--no-fund')
}
Write-Ok '引擎运行时依赖已就绪'

# ---------------------------------------------------------------- 应用图标
if (-not (Test-Path -LiteralPath 'build\icon.ico')) {
    Write-Step '生成应用图标'
    Invoke-Checked 'node' @('tools\make-icon.cjs')
    Write-Ok 'build\icon.ico'
}

# ---------------------------------------------------------------- 打包
Write-Step "打包 Windows 应用（$Arch）"

$builderArgs = @('electron-builder', '--win', "--$Arch")
if ($Dir) { $builderArgs += '--dir' }

Write-Host "    npx $($builderArgs -join ' ')" -ForegroundColor DarkGray
Invoke-Checked 'npx' $builderArgs

# ---------------------------------------------------------------- 结果
Write-Step '构建产物'

$releaseDir = Join-Path $PSScriptRoot 'release'
$unpackedName = if ($Arch -eq 'x64') { 'win-unpacked' } else { "win-$Arch-unpacked" }
$unpackedDir = Join-Path $releaseDir $unpackedName

$artifacts = @()
$unpackedExe = Join-Path $unpackedDir 'PokemonBattleSim.exe'
if (Test-Path -LiteralPath $unpackedExe) {
    $artifacts += Get-Item -LiteralPath $unpackedExe
}
$artifacts += @(Get-ChildItem -Path $releaseDir -Filter '*.exe' -File -ErrorAction SilentlyContinue)

if ($artifacts.Count -eq 0) {
    Fail '没有找到构建产物，请检查上方 electron-builder 日志。'
}

foreach ($item in $artifacts) {
    $sizeMb = [math]::Round($item.Length / 1MB, 1)
    Write-Host ("    {0,-46} {1,8} MB" -f $item.Name, $sizeMb)
}

Write-Host ''
Write-Host '完成。' -ForegroundColor Green
Write-Host "    免安装目录：$unpackedDir"
Write-Host "    安装包/便携版：$releaseDir"
Write-Host '    引擎外挂：<安装目录>\resources\engine'
Write-Host '              替换该目录下的 dist 即可更新引擎与宝可梦数据，无需重新打包。'
Write-Host ''
Write-Host '    注意：release 目录是完整应用，可直接复制到其他 Windows 机器运行。' -ForegroundColor DarkGray
Write-Host ''
