#!/bin/sh
# HarmonyOS PC 打包入口（鸿蒙 PC / Linux / macOS）
#
# 首次使用请先设置环境变量，例如：
#   export DEVECO_HOME="/path/to/deveco-studio"     # 自动探测 hvigor/ohpm/sdk
#   export OHOS_HAP_PATH="/path/to/libelectron/ohos_hap"
#   # 如需签名包再设置 OHOS_CERT_PATH / OHOS_PROFILE / OHOS_KEY_ALIAS /
#   #                  OHOS_KEY_PWD / OHOS_STORE_FILE / OHOS_STORE_PWD
#   ./build-ohos.sh --dry-run      # 先检查环境
#   ./build-ohos.sh                # 正式打包，产物在 release-ohos/
#
# 详细说明：node tools/build-ohos.cjs --help
set -eu
cd "$(dirname "$0")"
exec node tools/build-ohos.cjs "$@"
