# syntax=docker/dockerfile:1.7
#
# sdp-api — Node.js runtime image. Build context is the monorepo root:
#
#     docker build -f apps/sdp-api/Dockerfile -t sdp-api .

# Digest pinned so rebuilds don't float onto a new node:22-slim.
FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

FROM base AS deps
WORKDIR /repo

# Lockfile + workspace metadata first so the install layer only invalidates
# when versions change. Root tsconfig.json is needed for esbuild's "extends".
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY apps/sdp-api/package.json ./apps/sdp-api/
COPY packages/sdp-types/package.json ./packages/sdp-types/
COPY packages/sdp-env-config/package.json ./packages/sdp-env-config/
COPY packages/sdp-rpc/package.json ./packages/sdp-rpc/
COPY packages/sdp-custody/package.json ./packages/sdp-custody/
COPY patches ./patches

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @sdp/api...

FROM base AS builder
WORKDIR /repo

COPY --from=deps /repo /repo
COPY apps/sdp-api ./apps/sdp-api
COPY packages/sdp-types ./packages/sdp-types
COPY packages/sdp-env-config ./packages/sdp-env-config
COPY packages/sdp-rpc ./packages/sdp-rpc
COPY packages/sdp-custody ./packages/sdp-custody

WORKDIR /repo/apps/sdp-api
RUN node scripts/build-node.mjs

FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    HOSTNAME=0.0.0.0 \
    MIGRATIONS_DIR=/app/migrations

# Apply OS-level security patches not yet in the pinned base image.
# This layer is cached — rebuild with --no-cache to pick up new fixes.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

# UID/GID 1001 matches sdp-web so k8s securityContext is consistent.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs sdp

# Only the bundled artifact ships — no node_modules in the runner.
COPY --from=builder --chown=sdp:nodejs /repo/apps/sdp-api/dist /app

# Read at runtime by `node migrate.js` (MIGRATIONS_DIR); shipped as files, not bundled.
COPY --from=builder --chown=sdp:nodejs /repo/apps/sdp-api/src/db/migrations/postgres /app/migrations

# Pass --build-arg GIT_SHA=$(git rev-parse HEAD) to stamp the image.
ARG GIT_SHA=""
ARG IMAGE_SOURCE="https://github.com/solana-foundation/solana-developer-platform"
LABEL org.opencontainers.image.title="sdp-api" \
      org.opencontainers.image.description="Solana Developer Platform — API (Node.js runtime)" \
      org.opencontainers.image.source="$IMAGE_SOURCE" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Solana Foundation"

USER sdp
EXPOSE 8787

# Liveness only — status<500 means the HTTP layer is up. /ready (DB+Redis)
# belongs on a k8s readinessProbe, not on the container HEALTHCHECK.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
