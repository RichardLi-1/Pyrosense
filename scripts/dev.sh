#!/usr/bin/env bash
# Full local stack, no hardware: TimescaleDB + fake Pi + API + dashboard.
# Output is prefixed per process. Ctrl-C stops everything (the db container keeps running).
set -euo pipefail
cd "$(dirname "$0")/.."

[ -x backend/.venv/bin/python ] && [ -d dashboard/node_modules ] || { echo "run: make setup"; exit 1; }

make -s db

trap 'trap - EXIT; kill 0' INT TERM EXIT

run() { # label, command...
  local label=$1; shift
  "$@" 2>&1 | awk -v p="[$label] " '{ print p $0; fflush() }' &
}

run pi   make -s fake-pi
run api  make -s api-local
run dash make -s dashboard

echo "API http://localhost:8000/docs · live ws://localhost:8000/ws/live · dashboard http://localhost:5173"
wait
