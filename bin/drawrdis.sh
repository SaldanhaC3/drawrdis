#!/usr/bin/env sh
# Drawrdis launcher (macOS / Linux). Works from any install location.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORTFILE="$DIR/.drawrdis-port"
PORT="${DRAWRDIS_PORT:-3750}"

(node "$DIR/server.js" >/dev/null 2>&1 &)

# espera o servidor gravar a porta real (ele escala se 3750 estiver ocupada)
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ -f "$PORTFILE" ] && break
  sleep 1
done
[ -f "$PORTFILE" ] && PORT="$(cat "$PORTFILE")"

xdg-open "http://127.0.0.1:$PORT" 2>/dev/null || open "http://127.0.0.1:$PORT"
