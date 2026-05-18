# syntax=docker/dockerfile:1.7
# ──────────────────────────────────────────────────────────────────────────────
# sdp-web — Next.js standalone image (HOO-513)
#
# Build context MUST be the monorepo root (pnpm-lock + workspace package.json
# files live above apps/sdp-web). From the repo root:
#
#     docker build -f apps/sdp-web/Dockerfile -t sdp-web .
#
# NEXT_PUBLIC_* are baked into the client bundle at build time, so they have
# to be passed as --build-arg (not -e). SENTRY_AUTH_TOKEN is only needed to
# upload sourcemaps; it is read from BuildKit secret storage so it is never
# written into a layer. Pass it with:
#
#     docker build --secret id=sentry_auth_token,env=SENTRY_AUTH_TOKEN ...
#
# Runtime-only secrets (CLERK_SECRET_KEY, SDP_API_BASE_URL, etc.) belong on
# `docker run -e` / orchestrator secret stores, not here.
# ──────────────────────────────────────────────────────────────────────────────

# ── Base: pin Node + pnpm to the repo's packageManager ─────────────────────
FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

# ── Dependencies: install with frozen lockfile, sdp-web subgraph only ──────
FROM base AS deps
WORKDIR /repo

# Workspace metadata first — these files invalidate the install cache only
# when dependency versions actually change.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/sdp-web/package.json ./apps/sdp-web/
COPY packages/sdp-types/package.json ./packages/sdp-types/
COPY patches ./patches

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter sdp-web...

# ── Build: compile Next.js with NEXT_PUBLIC_* baked in ─────────────────────
FROM base AS builder
WORKDIR /repo

# Bring forward the installed workspace from `deps` and overlay the source.
COPY --from=deps /repo /repo
COPY apps/sdp-web ./apps/sdp-web
COPY packages/sdp-types ./packages/sdp-types

# Public env (each var is also exposed via ENV so Next picks it up at build).
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_SDP_API_BASE_URL
ARG NEXT_PUBLIC_SDP_DOCS_URL
ARG NEXT_PUBLIC_SOLANA_NETWORK
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_ENABLE_NETWORK_DEBUG
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
ARG NEXT_PUBLIC_CLERK_JWT_TEMPLATE
ARG NEXT_PUBLIC_CLERK_SIGN_IN_URL
ARG NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL
ARG NEXT_PUBLIC_CLERK_SIGN_UP_URL
ARG NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL
ENV NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL \
    NEXT_PUBLIC_SDP_API_BASE_URL=$NEXT_PUBLIC_SDP_API_BASE_URL \
    NEXT_PUBLIC_SDP_DOCS_URL=$NEXT_PUBLIC_SDP_DOCS_URL \
    NEXT_PUBLIC_SOLANA_NETWORK=$NEXT_PUBLIC_SOLANA_NETWORK \
    NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN \
    NEXT_PUBLIC_ENABLE_NETWORK_DEBUG=$NEXT_PUBLIC_ENABLE_NETWORK_DEBUG \
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY \
    NEXT_PUBLIC_CLERK_JWT_TEMPLATE=$NEXT_PUBLIC_CLERK_JWT_TEMPLATE \
    NEXT_PUBLIC_CLERK_SIGN_IN_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_URL \
    NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_URL \
    NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL=$NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL

# Sentry sourcemap upload is gated on SENTRY_AUTH_TOKEN. The secret is mounted
# only for the duration of this RUN and never written to a layer. If the
# secret is not provided the build still succeeds; sourcemaps just aren't
# uploaded.
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    pnpm --filter sdp-web build

# ── Runtime: slim image with only the standalone output ────────────────────
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Run as an unprivileged user. UID/GID 1001 matches the convention used by
# the upstream Next.js Docker example to make k8s securityContext predictable.
RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Next's standalone output already contains a pruned node_modules and the
# generated server.js entrypoint. .next/static and public must be copied
# alongside it because tracing intentionally skips them.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/sdp-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/sdp-web/.next/static ./apps/sdp-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/sdp-web/public ./apps/sdp-web/public

USER nextjs
EXPOSE 3000

CMD ["node", "apps/sdp-web/server.js"]
