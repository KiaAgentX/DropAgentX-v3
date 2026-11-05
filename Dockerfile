# DropAgentX v3 — single service (server + bot in one process), Railway-ready.
# Multi-stage: dependency manifests are copied first so the install layer is
# cached; tsx runs TS directly — no build step to drift (packages are
# source-linked).
# NOTE: no --mount=type=cache here. Railway rejects cache-mount ids without a
# service-scoped prefix (id=s/<service-id>-…), and hard-coding a service id in
# a public Dockerfile kills portability. Plain layer caching does the same job
# on every builder (Railway, GH Actions, local Docker).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm-store
RUN corepack enable pnpm && mkdir -p /pnpm-store
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json .npmrc ./
COPY back/server/package.json back/server/
COPY back/bot/package.json back/bot/
COPY front/dashboard/package.json front/dashboard/
COPY back/domain/package.json back/domain/
COPY back/contracts/package.json back/contracts/
COPY back/llm/package.json back/llm/
COPY back/ai-gateway/package.json back/ai-gateway/
RUN pnpm install --frozen-lockfile

FROM deps AS pruned
RUN pnpm prune --prod

FROM pruned AS runtime
ENV NODE_ENV=production
COPY --from=deps /app /app
# Production uses the pruned dependency tree; source ships whole (TS-first deploy).
COPY . .
# The runtime volume (mounted at /app/db) is created empty on first boot —
# never ship a host database inside the image (.dockerignore excludes db/).
RUN mkdir -p /app/db && chown -R node:node /app/db
USER node
EXPOSE 8787
# SQLite lives on the mounted volume; the single-service entry boots server + bot.
CMD ["pnpm", "-F", "@dropagentx/server", "exec", "tsx", "scripts/single-service.ts"]
