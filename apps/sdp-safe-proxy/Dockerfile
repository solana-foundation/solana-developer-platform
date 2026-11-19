# syntax=docker/dockerfile:1.7
#
# sdp-safe-proxy — Node.js runtime image. Build context is the monorepo root:
#
#     docker build -f apps/sdp-safe-proxy/Dockerfile -t sdp-safe-proxy .

# Digest pinned so rebuilds don't float onto a new node:24-slim.
FROM node:24-slim@sha256:8cabefbd444809cf0e319b5831c65da1ea202200ca552a5e75fd7938a6f86658 AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

FROM base AS deps
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY apps/sdp-safe-proxy/package.json ./apps/sdp-safe-proxy/
COPY packages/sdp-safe-proxy-catalog/package.json ./packages/sdp-safe-proxy-catalog/
COPY packages/sdp-service-call/package.json ./packages/sdp-service-call/
COPY patches ./patches

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @sdp/safe-proxy...

FROM base AS builder
WORKDIR /repo

COPY --from=deps /repo /repo
COPY apps/sdp-safe-proxy ./apps/sdp-safe-proxy
COPY packages/sdp-safe-proxy-catalog ./packages/sdp-safe-proxy-catalog
COPY packages/sdp-service-call ./packages/sdp-service-call

WORKDIR /repo/apps/sdp-safe-proxy
RUN node scripts/build-node.mjs

FROM node:24-slim@sha256:8cabefbd444809cf0e319b5831c65da1ea202200ca552a5e75fd7938a6f86658 AS runner
WORKDIR /app

ENV NODE_ENV=production

# Apply OS-level fixes not yet in the pinned base image.
# This layer is cached — rebuild with --no-cache to pick up new fixes.
RUN apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs sdp

# Only the bundled artifact ships — no node_modules in the runner.
COPY --from=builder --chown=sdp:nodejs /repo/apps/sdp-safe-proxy/dist /app

ARG GIT_SHA=""
ARG IMAGE_SOURCE="https://github.com/solana-foundation/solana-developer-platform"
LABEL org.opencontainers.image.title="sdp-safe-proxy" \
      org.opencontainers.image.description="Solana Developer Platform — Safe Proxy (Node.js runtime)" \
      org.opencontainers.image.source="$IMAGE_SOURCE" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Solana Foundation"

USER sdp

CMD ["node", "server.js"]
