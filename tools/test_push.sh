#!/usr/bin/env bash
# Перевірка ланцюжка Firebase без Home Assistant:
# входить як HA-користувач і пише тестовий /home/live.
#
#   API_KEY=... DB_URL=https://xxx.firebasedatabase.app EMAIL=ha@home.local PASS=... ./tools/test_push.sh
set -euo pipefail
: "${API_KEY:?}" "${DB_URL:?}" "${EMAIL:?}" "${PASS:?}"

RESP=$(curl -sS -X POST -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASS\",\"returnSecureToken\":true}" \
  "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$API_KEY")
TOKEN=$(printf '%s' "$RESP" | sed -n 's/.*"idToken": *"\([^"]*\)".*/\1/p')
UID_=$(printf '%s' "$RESP" | sed -n 's/.*"localId": *"\([^"]*\)".*/\1/p')
[ -n "$TOKEN" ] || { echo "Вхід не вдався: $RESP"; exit 1; }
echo "OK, uid HA-користувача: $UID_  (має бути в access/writers)"

curl -sS -X PUT -H 'Content-Type: application/json' "$DB_URL/home/live.json?auth=$TOKEN" -d '{
  "ts": {".sv":"timestamp"},
  "grid": {"on": true, "v": 229.1, "hz": 50.0},
  "out":  {"v": 230, "hz": 50, "p": 0, "va": 0, "pct": 0},
  "bat":  {"soc": 87, "v": 53.1, "a": 12.4, "p": 658, "t": 23},
  "inv":  {"mode": "Line", "t": 34, "fault": "0"}
}'
echo
echo "Відкрий дашборд — має з'явитись «Світло є», батарея 87%."
