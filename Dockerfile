# DropAgentX v3 — single service (server + bot in one process), Railway-ready.
# Multi-stage: pnpm fetch layer caches dependencies, tsx runs TS directly —
# no build step to drift (the monorepo packages are source-linked).

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
