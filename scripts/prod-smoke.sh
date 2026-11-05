#!/usr/bin/env bash
# prod-smoke.sh — the launch gate. Boots the single-service EXACTLY as Railway
# would (fresh volume-like temp DB, polling bot slot empty, AI triplet unset)
# and probes the production surface. Fails loudly on any launch blocker.
#
# Usage: bash scripts/prod-smoke.sh
set -euo pipefail
cd "$(dirname "$0")/.."

PORT_SMOKE=${PORT_SMOKE:-18787}
TMP=$(mktemp -d)
SMOKE_KEY=$(openssl rand -hex 24)   # smoke key only — never the real launch key

# — the launch environment (mirrors the Railway env JSON) —
export DATABASE_URL="file:$TMP/prod-smoke.db"
export KIA_ADMIN_KEY="$SMOKE_KEY"
export PORT="$PORT_SMOKE"
unset TELEGRAM_BOT_TOKEN OPENAI_BASE_URL OPENAI_API_KEY MODEL BOT_MODE 2>/dev/null || true

pnpm -F @dropagentx/server exec tsx scripts/single-service.ts &
APP_PID=$!
trap 'kill "$APP_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT_SMOKE/api/v1/health" >/dev/null 2>&1 && break
  sleep 0.5
done

BASE="http://127.0.0.1:$PORT_SMOKE/api/v1"

# 1 — health (Railway healthcheck path)
curl -sf "$BASE/health" >/dev/null || { echo "FAIL: /health unreachable"; exit 1; }
echo "OK 1  /api/v1/health → 200"

# 2 — OpenAPI 3.1 document, generated from the zod contracts
OAS=$(curl -sf "$BASE/openapi.json")
echo "$OAS" | grep -q '"openapi":"3\.1' || { echo "FAIL: OpenAPI version not 3.1"; exit 1; }
echo "$OAS" | grep -qi 'DropAgentX' || { echo "FAIL: OpenAPI title missing"; exit 1; }
NPATHS=$(echo "$OAS" | python3 -c "import sys,json;print(len(json.load(sys.stdin)['paths']))")
echo "OK 2  /api/v1/openapi.json → OpenAPI 3.1, $NPATHS paths"

# 3 — browsable docs
curl -sf "$BASE/docs" >/dev/null || { echo "FAIL: /docs unreachable"; exit 1; }
echo "OK 3  /api/v1/docs → 200"

# 4 — fail-closed: admin surface refuses the keyless world
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/hitl")
[ "$CODE" = "401" ] || { echo "FAIL: /hitl without key → $CODE (expected 401)"; exit 1; }
echo "OK 4  fail-closed: /hitl without X-KIA-Key → 401"

# 5 — admin surface opens with the key
CODE=$(curl -s -o /dev/null -w '%{http_code}' -H "X-KIA-Key: $SMOKE_KEY" "$BASE/hitl")
[ "$CODE" = "200" ] || { echo "FAIL: /hitl with key → $CODE (expected 200)"; exit 1; }
echo "OK 5  /hitl with X-KIA-Key → 200"

# 6 — public economy audit (the nation can always audit its own money)
CODE=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/economy")
[ "$CODE" = "200" ] || { echo "FAIL: /economy → $CODE (expected 200)"; exit 1; }
echo "OK 6  /economy → 200 (public read)"

kill "$APP_PID" 2>/dev/null || true
wait "$APP_PID" 2>/dev/null || true
trap - EXIT
echo "SMOKE OK — production surface ready for launch."
