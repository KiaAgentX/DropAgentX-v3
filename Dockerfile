# DropAgentX v3 — single service (server + bot in one process), Railway-ready.
# Multi-stage: pnpm fetch layer caches dependencies, tsx runs TS directly —
# no build step to drift (the monorepo packages are source-linked).

FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm-store
RUN corepack enable pnpm && mkdir -p /pnpm-store
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json .npmrc ./
COPY apps/server/package.json apps/server/
COPY apps/bot/package.json apps/bot/
COPY apps/dashboard/package.json apps/dashboard/
COPY packages/domain/package.json packages/domain/
COPY packages/contracts/package.json packages/contracts/
COPY packages/llm/package.json packages/llm/
COPY packages/ai-gateway/package.json packages/ai-gateway/
RUN --mount=type=cache,id=pnpm,target=/pnpm-store pnpm install --frozen-lockfile

FROM deps AS pruned
RUN --mount=type=cache,id=pnpm,target=/pnpm-store pnpm prune --prod

FROM pruned AS runtime
ENV NODE_ENV=production
COPY --from=deps /app /app
# Production uses the pruned dependency tree; source ships whole (TS-first deploy).
COPY . .
RUN chown -R node:node /app/db
USER node
EXPOSE 8787
# SQLite lives on the mounted volume; the single-service entry boots server + bot.
CMD ["pnpm", "-F", "@dropagentx/server", "exec", "tsx", "scripts/single-service.ts"]
