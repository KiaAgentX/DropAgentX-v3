# DropAgentX v3 — single service (server + bot in one process), Railway-ready.
# Multi-stage: dependency manifests are copied first so the install layer is
# cached; tsx runs TS directly — no build step to drift (packages are
# source-linked).
#
# Two cold-build facts this file encodes (learned the hard way — a Railway
# deploy fails at `pnpm install` without them):
# 1. `prisma generate` runs as a workspace postinstall during `pnpm install`,
#    so the schema must exist in the install stage. Manifests alone are not
#    enough — the postinstall fails with "Could not find Prisma Schema" and
#    takes the whole install down with exit code 1.
# 2. better-sqlite3 v13 ships no prebuilt binaries — it compiles from source,
#    which needs python3/make/g++. node:24-slim carries none of them, so the
#    tools are installed in the install stage ONLY; the runtime stage stays a
#    clean slim image.
# NOTE: no --mount=type=cache here. Railway rejects cache-mount ids without a
# service-scoped prefix (id=s/<service-id>-…), and hard-coding a service id in
# a public Dockerfile kills portability. Plain layer caching does the same job
# on every builder (Railway, GH Actions, local Docker).

FROM node:24-slim AS deps
ENV PNPM_HOME=/pnpm-store \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/usr/local/share/corepack
# Native-module toolchain (better-sqlite3 has no prebuilds) — install stage
# only; kept out of the runtime image below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
# Pin the exact pnpm from root package.json `packageManager` — no per-run
# registry drift, and the runtime stage has no package.json yet when it needs
# the binary.
RUN corepack enable pnpm && corepack prepare pnpm@9.15.9 --activate \
 && mkdir -p /pnpm-store
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json turbo.json .npmrc ./
COPY back/server/package.json back/server/
# The postinstall above runs `prisma generate` — it needs the schema here.
COPY back/server/prisma back/server/prisma/
COPY back/bot/package.json back/bot/
COPY front/dashboard/package.json front/dashboard/
COPY back/domain/package.json back/domain/
COPY back/contracts/package.json back/contracts/
COPY back/llm/package.json back/llm/
COPY back/ai-gateway/package.json back/ai-gateway/
# append-only keeps every postinstall line in build logs; the default bar
# reporter can bury the one error that matters on CI.
RUN pnpm install --frozen-lockfile --reporter=append-only --fetch-retries=5

FROM node:24-slim AS runtime
ENV NODE_ENV=production \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    COREPACK_HOME=/usr/local/share/corepack
# pnpm is prepared INTO the image (world-readable corepack cache) so the boot
# gate (`prisma db push` on a fresh volume) never waits on a runtime download.
RUN corepack enable pnpm && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY --from=deps /app /app
# Source ships whole (TS-first deploy); .dockerignore keeps host state and
# secrets out. The runtime volume (mounted at /app/db) is created empty on
# first boot — never ship a host database inside the image (.dockerignore
# excludes db/).
COPY . .
RUN mkdir -p /app/db && chown -R node:node /app/db
USER node
EXPOSE 8787
# SQLite lives on the mounted volume; the single-service entry boots server + bot.
CMD ["pnpm", "-F", "@dropagentx/server", "exec", "tsx", "scripts/single-service.ts"]
