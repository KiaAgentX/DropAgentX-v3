# DropAgentX v3 — 1.0.0

Six phases delivered on this commit: domain core, server+contracts, bot+HITL,
Aurora dashboard, AI gateway (6 agents / 16 skills), legacy migration + release.

- Layout: front/ (Aurora dashboard) + back/ (server, bot, domain, contracts,
  llm, ai-gateway) — pnpm + turbo, TypeScript strict, 187 tests green.
- Deploy: docs/DEPLOY.md (Railway single service, Dockerfile + railway.json).
- Migration: back/server/scripts/migrate-legacy.ts (replay-safe, proof included).
- Sacred rules: integer D, double-entry closure, escrow state machine,
  HITL >= 50,000 D, Result errors, secrets never in git.
