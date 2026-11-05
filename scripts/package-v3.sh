#!/usr/bin/env bash
# package-v3.sh — the v1.5.0 QC ritual, adapted to v3-core.
#
# Produces download/DropAgentX-v3-<version>.zip containing:
#   git-archive of HEAD + full .git (local commits exist nowhere else until the
#   owner pushes) + blank-secrets .env + HANDOFF + SHA256 sidecar.
#
# QC gates (fail loudly, never ship a bad package):
#   1. clean tree (all work committed)
#   2. git fsck passes
#   3. tests + typecheck green across the monorepo
#   4. version consistency (root == every workspace package)
#   5. zero real secrets in the shipped .env template

set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
OUT="/home/z/my-project/download"
NAME="DropAgentX-v3-${VERSION}.zip"

echo "── QC 1: clean tree"
if [ -n "$(git status --porcelain)" ]; then
  echo "FAIL: working tree is dirty — commit everything first."; git status --short | head; exit 1
fi
echo "   ok (HEAD $(git log -1 --format='%h %s'))"

echo "── QC 2: git fsck"
git fsck --no-dangling >/dev/null
echo "   ok"

echo "── QC 3: tests + typecheck"
pnpm typecheck >/dev/null 2>&1 || { echo "FAIL: typecheck"; exit 1; }
TESTS=$(pnpm -r --no-bail test 2>/dev/null | grep -oE "Tests  [0-9]+ passed" | awk '{s+=$2} END {print s}')
if [ "${TESTS:-0}" -lt 180 ]; then echo "FAIL: expected ≥180 tests, got ${TESTS:-0}"; exit 1; fi
echo "   ok (${TESTS} tests green)"

echo "── QC 4: version consistency"
for f in back/*/package.json front/*/package.json; do
  V=$(node -p "require('./$f').version")
  [ "$V" = "$VERSION" ] || { echo "FAIL: $f is $V ≠ $VERSION"; exit 1; }
done
echo "   ok (@ $VERSION)"

echo "── QC 5: secret guard on .env.example"
if grep -E "^(KIA_ADMIN_KEY|OPENAI_API_KEY|TELEGRAM_BOT_TOKEN)=..+" .env.example | grep -vE "^\w+=<" >/dev/null 2>&1; then
  echo "FAIL: .env.example contains a real-looking secret"; exit 1
fi
echo "   ok (blank template)"

STAGE=$(mktemp -d)
mkdir -p "$OUT"
git archive --format=tar HEAD | tar -x -C "$STAGE"
# the .git directory travels inside the ZIP (single source of truth until push)
cp -r .git "$STAGE/.git"
cp .env.example "$STAGE/.env"
cat > "$STAGE/HANDOFF.md" << EOF
# DropAgentX v3 — ${VERSION}

Six phases delivered on this commit: domain core, server+contracts, bot+HITL,
Aurora dashboard, AI gateway (6 agents / 16 skills), legacy migration + release.

- Layout: front/ (Aurora dashboard) + back/ (server, bot, domain, contracts,
  llm, ai-gateway) — pnpm + turbo, TypeScript strict, ${TESTS} tests green.
- Deploy: docs/DEPLOY.md (Railway single service, Dockerfile + railway.json).
- Migration: back/server/scripts/migrate-legacy.ts (replay-safe, proof included).
- Sacred rules: integer D, double-entry closure, escrow state machine,
  HITL >= 50,000 D, Result errors, secrets never in git.
EOF
# rebuild from scratch — zip -qr UPDATES an existing archive instead of replacing it
rm -f "$OUT/$NAME" "$OUT/$NAME.sha256"
( cd "$STAGE" && zip -qr "$OUT/$NAME" . )
sha256sum "$OUT/$NAME" | tee "$OUT/$NAME.sha256"

FILES=$(unzip -l "$OUT/$NAME" | tail -1 | awk '{print $2}')
echo "── package: $OUT/$NAME (${FILES} files)"

echo "── QC 6: layout purity inside the zip"
STALE=$(unzip -l "$OUT/$NAME" | grep -cE ' \**(apps|packages)/' || true)
if [ "$STALE" -gt 0 ]; then echo "FAIL: $STALE stale apps/|packages/ entries in the zip"; exit 1; fi
if ! unzip -l "$OUT/$NAME" | grep -q ' front/' || ! unzip -l "$OUT/$NAME" | grep -q ' back/'; then
  echo "FAIL: front/ or back/ missing from the zip"; exit 1
fi
echo "   ok (front/ + back/ only, no legacy paths)"
rm -rf "$STAGE"
echo "DONE — v3 ${VERSION} packaged."
