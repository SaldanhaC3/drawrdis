#!/usr/bin/env sh
# Opens a .drawrdis / .json board file: starts the server if needed,
# loads the file into the board and opens the browser.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORTFILE="$DIR/.drawrdis-port"
FILE="$(realpath "$1")"
PORT="${DRAWRDIS_PORT:-3750}"
[ -f "$PORTFILE" ] && PORT="$(cat "$PORTFILE")"

curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/scene" || {
  (node "$DIR/server.js" >/dev/null 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do [ -f "$PORTFILE" ] && break; sleep 1; done
  [ -f "$PORTFILE" ] && PORT="$(cat "$PORTFILE")"
}

curl -s -X POST -H "content-type: application/json" --data-binary "@$FILE" "http://127.0.0.1:$PORT/open" >/dev/null
xdg-open "http://127.0.0.1:$PORT" 2>/dev/null || open "http://127.0.0.1:$PORT"
