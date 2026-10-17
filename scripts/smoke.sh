#!/usr/bin/env bash
# GET every REST route once; print status, type and a short preview.
# Skips POST /session (it resets the live session). Exit 1 on any 5xx or connection failure.
#   BASE=http://vm:8000 scripts/smoke.sh
set -uo pipefail
BASE=${BASE:-http://localhost:8000}
body=$(mktemp); trap 'rm -f "$body"' EXIT
fail=0

check() {
  local path=$1 meta code type preview
  meta=$(curl -s -m 40 -o "$body" -w '%{http_code} %{content_type}' "$BASE$path")
  code=${meta%% *}; type=${meta#* }
  if [[ $type == application/json* ]]; then
    preview=$(jq -c 'if type == "array" then "[\(length) items] \(.[0] // "" | tostring)" else . end' "$body" | cut -c1-110)
  else
    preview="<$(wc -c < "$body" | tr -d ' ') bytes>"
  fi
  case $code in 2*) mark=ok ;; 4*) mark=-- ;; *) mark=FAIL; fail=1 ;; esac
  printf '%-4s %s  %-28s %s\n' "$mark" "$code" "$path" "$preview"
}

for p in / /health /session /sessions /heatmap /trail?limit=5 /map /map/meta /alerts /summary; do
  check "$p"
done

id=$(curl -s "$BASE/alerts" | jq -r 'if type == "array" then .[0].id // empty else empty end' 2>/dev/null)
[ -n "$id" ] && check "/alerts/$id/map.png"

exit $fail
