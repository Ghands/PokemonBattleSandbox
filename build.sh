#!/usr/bin/env bash
# =====================================================================
# 宝可梦对战沙盘 · 干净构建包入口（Linux / macOS）
#
# 本文件夹不含 Node.js / node_modules / Pokemon Showdown 源码。
# 无可用 Node 时自动下载便携版，再由 bootstrap.cjs 完成其余下载与构建。
#
# 用法: ./build.sh --os linux --arch x64
#       ./build.sh --os all --arch all
#       ./build.sh --setup-only
# =====================================================================
set -euo pipefail

KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$KIT"

VER="$(cat "$KIT/.node-version" 2>/dev/null || echo '22.22.2')"
VER="${PBSIM_NODE_VERSION:-$VER}"

case "$(uname -m)" in
  x86_64|amd64) NARCH="x64" ;;
  aarch64|arm64) NARCH="arm64" ;;
  *) echo "[kit] unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac
if [[ "$(uname -s)" == "Darwin" ]]; then
  NPLAT="darwin"; EXT="tar.gz"; TARFLAG="-xzf"
else
  NPLAT="linux"; EXT="tar.xz"; TARFLAG="-xJf"
fi

NODE_BIN="${PBSIM_NODE:-}"
if [[ -z "$NODE_BIN" && -x "$KIT/.runtime/node/bin/node" ]]; then
  NODE_BIN="$KIT/.runtime/node/bin/node"
fi
if [[ -z "$NODE_BIN" && "${PBSIM_FORCE_NODE:-0}" != "1" ]] && command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "[kit] Node.js not found - downloading portable Node v${VER} (${NPLAT}/${NARCH}) ..."
  mkdir -p "$KIT/.runtime"
  NAME="node-v${VER}-${NPLAT}-${NARCH}.${EXT}"
  ARCHIVE="$KIT/.runtime/$NAME"
  BASE="${PBSIM_NODE_MIRROR:-https://npmmirror.com/mirrors/node}/v${VER}/${NAME}"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 20 -o "$ARCHIVE" "$BASE" \
      || curl -fsSL --retry 3 --connect-timeout 20 -o "$ARCHIVE" "https://nodejs.org/dist/v${VER}/${NAME}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$ARCHIVE" "$BASE"
  else
    echo "[kit] ERROR: neither curl nor wget is available." >&2
    exit 1
  fi
  tar "$TARFLAG" "$ARCHIVE" -C "$KIT/.runtime"
  rm -rf "$KIT/.runtime/node"
  mv "$KIT/.runtime/node-v${VER}-${NPLAT}-${NARCH}" "$KIT/.runtime/node"
  rm -f "$ARCHIVE"
  NODE_BIN="$KIT/.runtime/node/bin/node"
  echo "[kit] portable Node ready: $NODE_BIN"
fi

echo "[kit] Node: $NODE_BIN"
exec "$NODE_BIN" "$KIT/bootstrap.cjs" "$@"
