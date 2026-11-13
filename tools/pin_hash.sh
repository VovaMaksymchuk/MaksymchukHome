#!/usr/bin/env bash
# Рахує значення для pin/hash у Realtime Database.
#   ./tools/pin_hash.sh <projectId> <пароль>
# Приклад: ./tools/pin_hash.sh my-home-dash 482915
set -euo pipefail
[ $# -eq 2 ] || { echo "usage: $0 <projectId> <пароль>"; exit 1; }
if command -v shasum >/dev/null; then H=$(printf '%s' "$1:$2" | shasum -a 256)
else H=$(printf '%s' "$1:$2" | sha256sum); fi
echo "pin/hash = ${H%% *}"
echo "Firebase console → Realtime Database → Data → додай вузол pin → hash з цим значенням."
