# DEPLOY — DropAgentX v3 on Railway (single service)

One process = Fastify server + Telegram bot + HITL sweep (the DNA-v2 pattern).
SQLite on a mounted volume; the AI cycle is optional (ADR-006: all three env
vars together, or none).

## 1. Create the project

1. Railway → New Project → Deploy from GitHub repo (`KiaAgentX/DropAgentX-v3`).
2. Add a **Volume** mounted at `/app/db` (SQLite lives there — daily backups are
   the Railway volume snapshots; export monthly to the release archive too).
3. Set the variables (`.env.example` is the authoritative list):

   ```
   DATABASE_URL=file:/app/db/v3.db
   KIA_ADMIN_KEY=<openssl rand -hex 24>
   TELEGRAM_BOT_TOKEN=<from @BotFather>
   TELEGRAM_ADMIN_CHAT_ID=<your numeric chat id>
   BOT_MODE=webhook
   BOT_WEBHOOK_URL=https://<app>.up.railway.app/api/v1/bot/webhook
   TELEGRAM_WEBHOOK_SECRET=<openssl rand -hex 24>
   OPENAI_BASE_URL=https://<provider>/v1      # ← optional AI cycle
   OPENAI_API_KEY=...
   MODEL=...
   ```

4. Deploy. Health check: `GET /api/v1/health` → `{"status":"ok", …}`.

> **Fresh-volume note:** on first boot the single-service runs `prisma db push
> --skip-generate` against the mounted volume (idempotent — creates the schema
> on an empty volume, syncs additive drift, refuses destructive changes).
> Launch gate: `bash scripts/prod-smoke.sh` reproduces this boot locally.

## 2. Migrate the legacy economy (once)

From any machine with the legacy DB (never upload the backup to Railway —
the migration is offline and local):

```bash
pnpm install
pnpm -F @dropagentx/server exec tsx scripts/migrate-legacy.ts \
  --legacy /path/to/marketplace-20260924-0400.db \
  --target "file:$PWD/back/server/db/v3.db"
pnpm -F @dropagentx/server exec tsx scripts/genesis-proof.ts \
  --db "file:$PWD/back/server/db/v3.db"     # must print: PROOF OK — Σ 187,672 Đ
```

Upload the produced `v3.db` into the Railway volume (Railway shell: stop the
service, replace the file, redeploy). The migration is replay-safe: running it
twice can never double-mint (idempotency `legacy:genesis:v1`).

## 3. Verify after deploy

```bash
curl -s https://<app>.up.railway.app/api/v1/health
curl -s https://<app>.up.railway.app/api/v1/economy | jq '.circulatingSupply'   # 187672
curl -s -H "x-kia-key: $KIA_ADMIN_KEY" https://<app>.up.railway.app/api/v1/ai/skills | jq '.items | length'   # 16
```

The bot answers `/balance` in Telegram; the dashboard (`front/dashboard`,
served statically in a later step or via Vercel) manages the rest.

## Notes

- **Scaling**: one replica only — SQLite is the source of truth and the bot
  polls one queue. Vertical scale first.
- **Secrets**: never in git; the shipped `.env` is blank (QC ritual).
- **AI optional**: an AI-less deployment answers `/ai/*` with 503 — the rest of
  the platform works untouched.
