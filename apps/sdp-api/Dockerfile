# syntax=docker/dockerfile:1.7
#
# sdp-api — Node.js runtime image. Build context is the monorepo root:
#
#     docker build -f apps/sdp-api/Dockerfile -t sdp-api .
#
# `@sdp/veda` owns the PRIVATE `@vedatech/svm-sdk` package, so the deps stage
# needs a read-only npm token for the `@vedatech` scope. Pass it as a BuildKit
# SECRET — never `--build-arg`, and never `ENV`: both persist in the published
# image's layer history and `docker history` prints them.
#
#     docker build -f apps/sdp-api/Dockerfile -t sdp-api . \
#       --secret id=npm_token,src=$HOME/.secrets/veda-npm.env
#
# The secret's contents may be either a bare token or a `NPM_TOKEN=…` env file;
# the deps stage accepts both so the same file works for `docker build`,
# `docker compose build` and `docker run --env-file`.

# Digest pinned so rebuilds don't float onto a new node:24-slim.
FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS base
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
COPY packages/sdp-earn/package.json ./packages/sdp-earn/
COPY packages/sdp-payments/package.json ./packages/sdp-payments/
COPY packages/sdp-rpc/package.json ./packages/sdp-rpc/
COPY packages/sdp-custody/package.json ./packages/sdp-custody/
COPY packages/sdp-solana/package.json ./packages/sdp-solana/
COPY packages/sdp-policy/package.json ./packages/sdp-policy/
COPY packages/sdp-issuance/package.json ./packages/sdp-issuance/
COPY packages/sdp-private-channels/package.json ./packages/sdp-private-channels/
COPY packages/sdp-spc-escrow/package.json ./packages/sdp-spc-escrow/
COPY packages/sdp-spc-withdraw/package.json ./packages/sdp-spc-withdraw/
COPY packages/kit-augment/package.json ./packages/kit-augment/
COPY packages/sdp-kamino/package.json ./packages/sdp-kamino/
COPY patches ./patches

# The secret is read INSIDE the RUN and never assigned with ENV/ARG, so it lives
# only in this layer's process environment and leaves no trace in the image.
# `set +x`-style discipline throughout: the value is never echoed, and the
# fallback path prints the flag to pass, never what it should contain.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=npm_token \
    if [ -f /run/secrets/npm_token ]; then \
      NPM_TOKEN="$(sed -n 's/^[[:space:]]*NPM_TOKEN=//p' /run/secrets/npm_token | tail -n1)"; \
      [ -n "$NPM_TOKEN" ] || NPM_TOKEN="$(tr -d ' \t\r\n' < /run/secrets/npm_token)"; \
      export NPM_TOKEN; \
    else \
      echo "warning: no npm_token build secret; @vedatech/svm-sdk will 404. Pass --secret id=npm_token,src=<env file or token file>." >&2; \
    fi; \
    pnpm install --frozen-lockfile --filter @sdp/api...

FROM base AS builder
WORKDIR /repo

COPY --from=deps /repo /repo
COPY apps/sdp-api ./apps/sdp-api
COPY packages/sdp-types ./packages/sdp-types
COPY packages/sdp-env-config ./packages/sdp-env-config
COPY packages/sdp-earn ./packages/sdp-earn
COPY packages/sdp-payments ./packages/sdp-payments
COPY packages/sdp-rpc ./packages/sdp-rpc
COPY packages/sdp-custody ./packages/sdp-custody
COPY packages/sdp-solana ./packages/sdp-solana
COPY packages/sdp-policy ./packages/sdp-policy
COPY packages/sdp-issuance ./packages/sdp-issuance
COPY packages/sdp-private-channels ./packages/sdp-private-channels
COPY packages/sdp-spc-escrow ./packages/sdp-spc-escrow
COPY packages/sdp-spc-withdraw ./packages/sdp-spc-withdraw
COPY packages/kit-augment ./packages/kit-augment
COPY packages/sdp-kamino ./packages/sdp-kamino

WORKDIR /repo/apps/sdp-api
RUN node scripts/build-node.mjs

FROM node:24-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03 AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=8787 \
    HOSTNAME=0.0.0.0 \
    MIGRATIONS_DIR=/app/migrations

# Update npm for patched node-tar (CVE-2026-59873) and apply OS-level fixes
# not yet in the pinned base image.
# This layer is cached — rebuild with --no-cache to pick up new fixes.
RUN npm install --global npm@12.0.2 \
 && npm cache clean --force \
 && apt-get update \
 && apt-get upgrade -y \
 && rm -rf /var/lib/apt/lists/*

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

# Liveness only — status<500 means the HTTP layer is up. /health/ready (DB+Redis)
# belongs on a k8s readinessProbe, not on the container HEALTHCHECK.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
