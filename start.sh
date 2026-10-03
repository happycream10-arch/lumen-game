#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
echo 'Open http://localhost:3000 after the server starts.'
exec node standalone/server.mjs
