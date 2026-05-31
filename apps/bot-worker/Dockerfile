# syntax=docker/dockerfile:1.7
#
# Bot-worker production image. The build is a two-stage classic:
#   1. builder — installs the full monorepo (workspace deps resolve
#      across packages), then tsc-builds bot-worker + its engine
#      project references into dist/.
#   2. runtime — copies just the build output + production deps. Smaller
#      surface; no tsc, no source maps, no test fixtures.
#
# Why pnpm deploy is NOT used: pnpm@9's `deploy` command flattens the
# workspace into a single dir, but it doesn't preserve the workspace:*
# linking pattern that `@risezome/engine` and `@risezome/shared-types`
# rely on at runtime resolution. The straight copy-the-monorepo
# approach is simpler and the image is still ~120MB.
#
# Build context: this Dockerfile expects the MONOREPO ROOT as build
# context, not apps/bot-worker. Use `fly deploy --dockerfile
# apps/bot-worker/Dockerfile` from the repo root.

# ── builder ──────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /repo

# corepack pins pnpm to the lockfile's declared version
RUN corepack enable

COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY tsconfig.base.json ./
COPY apps/bot-worker/package.json apps/bot-worker/
COPY packages/engine/package.json packages/engine/
COPY packages/shared-types/package.json packages/shared-types/

RUN pnpm install --frozen-lockfile --filter @risezome/bot-worker...

COPY packages/shared-types ./packages/shared-types
COPY packages/engine ./packages/engine
COPY apps/bot-worker ./apps/bot-worker

RUN pnpm --filter @risezome/bot-worker build

# ── runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo

RUN corepack enable

# Copy lockfile + workspace manifests so pnpm install --prod can
# resolve the workspace graph. We keep the dist/ output from builder
# but rebuild node_modules without devDeps.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/bot-worker/package.json apps/bot-worker/
COPY packages/engine/package.json packages/engine/
COPY packages/shared-types/package.json packages/shared-types/

RUN pnpm install --frozen-lockfile --prod --filter @risezome/bot-worker...

# Copy the compiled output for bot-worker + the engine packages it
# depends on at runtime.
COPY --from=builder /repo/apps/bot-worker/dist ./apps/bot-worker/dist
COPY --from=builder /repo/packages/engine/dist ./packages/engine/dist
COPY --from=builder /repo/packages/shared-types/dist ./packages/shared-types/dist

ENV NODE_ENV=production
ENV BOT_WORKER_PORT=8080
EXPOSE 8080

# Health check matches fly.toml's [[services.http_checks]] entry.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${BOT_WORKER_PORT}/health" || exit 1

CMD ["node", "apps/bot-worker/dist/index.js"]
