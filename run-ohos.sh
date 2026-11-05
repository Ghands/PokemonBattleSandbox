#!/bin/sh
# No-package run mode for HarmonyOS PC (and any Linux/macOS box with Node).
# Starts the local bridge server and opens the UI in the browser.
# This is also the fastest way to verify the app without a signed HAP.
set -eu
cd "$(dirname "$0")"
PORT="${PORT:-8931}"
URL="http://127.0.0.1:${PORT}/"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js not found; please install Node >= 22.18" >&2
  exit 1
fi
if [ ! -f pokemon-showdown-master/dist/sim/index.js ]; then
  echo "Building engine (first run)..."
  npm run build:engine
fi
if [ ! -d pokemon-showdown-master/node_modules/ts-chacha20 ]; then
  echo "Installing engine runtime dependency..."
  npm i --prefix pokemon-showdown-master --omit=dev --no-save ts-chacha20
fi

echo "PokemonBattleSim: $URL"
echo "Press Ctrl+C to stop."
if command -v xdg-open >/dev/null 2>&1; then
  ( sleep 2; xdg-open "$URL" >/dev/null 2>&1 || true ) &
elif command -v open >/dev/null 2>&1; then
  ( sleep 2; open "$URL" >/dev/null 2>&1 || true ) &
fi
export PORT
exec node app/server.cjs
