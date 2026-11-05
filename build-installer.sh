#!/usr/bin/env bash
# 兼容入口：统一走 build.sh（它会自动下载缺失的 Node.js、npm 依赖与引擎源码）
exec "$(dirname "${BASH_SOURCE[0]}")/build.sh" "$@"
