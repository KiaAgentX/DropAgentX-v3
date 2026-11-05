# ADR-008 — AI Gateway: 6 Zenovix agents + 16 KIA-OS skills over the ADR-006 wire

- **Status**: accepted (Phase 5)
- **Date**: 2026-11-05
- **Deciders**: project owner + Claude
- **Supersedes**: none. Builds directly on **ADR-006** (OpenAI-compatible LLM layer)
  and **ADR-005** (zod → OpenAPI contracts).

## Context

Phase 5 closes the "AI cycle" of the v3 product thesis. The legacy empire already
proves the demand: Zenovix (6 agents + RAG + HITL) and KIA-OS (fail-closed tooling)
are the pieces users actually pay for (thesis layer 3 — AI Add-on with a spend cap
and a transparent per-user bill). What v3 must fix is the *spine*: the legacy AI
layer talked to ad-hoc providers and its tool boundary could not prove that money
actions were gated.

## Decision

1. **One wire, N providers** (extends ADR-006, does not replace it).
   The gateway accepts an ordered list of ADR-006-shaped triplets:
   `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `MODEL` (primary, required),
   `…_2` (secondary, optional), `…_3` (fallback, optional). Every triplet is
   all-or-nothing per provider; a partial slot refuses to boot the process.
   Learning from the legacy Hermes 9router — but locked to one wire shape.

2. **Deterministic fallback.** One decisive walk per call: primary → secondary →
   fallback, in the same order every time; every failure code (auth, rate limit,
   provider error, timeout, network, malformed) falls through; the winner is
   labeled in the response and the audit event. No health caching, no stickiness.

3. **JSON envelope instead of provider function-calling.** Agents answer with
   exactly one JSON object: `{"reply": "…"}` or `{"tool": "<skill_id>", "args": {…}}`.
   Two malformed envelopes (or a malformed one in the forced-final round) fail
   closed — raw model text is never relayed. This keeps every OpenAI-compatible
   endpoint usable identically and the whole loop testable offline.

4. **Exactly 16 skills, one registry.** `back/ai-gateway/src/skills.ts` owns
   identity, fa/en metadata, kind (`read|write|money|staff`), agent allow-lists
   and zod argument schemas. The gate (unknown skill / wrong agent / non-staff
   on a staff skill / invalid args) runs BEFORE the executor port — refusals
   never touch business code. Mapping of the legacy 22 tools → 16 v3 skills:
   dropped coupon/quest/leaderboard/referral/broadcast/booking/web/coupon-era
   tools; added v3-native `escrow_deliver`, `escrow_release`, `wallet_history`,
   `economy_status`.

5. **Agents are pure data.** 6 Zenovix personas (orchestrator, receptionist,
   sales, support, analyst, content) ported from legacy with three v3 rule
   deltas: money is integer Đ and never invented; money moves only through the
   escrow/ledger skills; amounts ≥ 50,000 Đ are honestly described as needing
   human approval. `allowedSkills` is DERIVED from the skill registry (single
   source of truth — no drift between prompt manifest and gate).

6. **Metering is a port, persisted on the server.** Per-user, per-UTC-day token
   cap (default 120,000, `AI_DAILY_TOKEN_CAP`), checked BEFORE any provider call;
   routing and every chat call feed the same bill (`AiUsage` table). An exhausted
   budget refuses with `AI_BUDGET_EXCEEDED` — no surprise bills.

7. **Audit + redaction on every outcome.** The 9 legacy redaction rules
   (PEM, bearer, JWT, sk-keys, bot tokens, AWS ids, card-like numbers, seed
   phrases, long hex) port verbatim and run on every final reply; the audit
   event (`ai.ok|refused|failed|pending` in `AuditLog`) records provider, model,
   tokens, redaction count and outcome.

8. **Staff is fail-closed at the HTTP boundary.** `role: "staff"` in
   `POST /ai/chat` is honored only behind a valid `X-KIA-Key`; the analyst agent
   and staff skills are additionally unreachable through routing for non-staff
   callers. `/ai/usage` (spend data) is admin-only.

## Consequences

- Positive: one transport for all providers; offline-testable loop; registry and
  manifest can never drift; HITL double-net (gateway files ≥ 50k, domain enforces
  again inside `releaseEscrow`); per-user bills that survive restarts (Prisma).
- Negative / accepted: JSON envelopes cost one extra parse round-trip vs native
  function-calling; meter granularity is per-request (a single turn may exceed
  the cap by one turn's tokens); full ledger state per command remains the scale
  trade-off documented in Phase 2.

## Verification (Phase 5 acceptance)

- Primary down → secondary serves: package test + server integration test.
- Every response audited + redacted: package tests + server tests assert audit
  rows (`ai.ok`, `ai.pending`) and `[REDACTED]` output with counts.
- 187/187 tests green across the monorepo (domain 40, llm 17, contracts 11,
  ai-gateway 29, bot 20, server 35, dashboard 35); tsc strict clean on 7 projects.
