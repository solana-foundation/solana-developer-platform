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
# Digest pinned so rebuilds don't silently float onto a new node:22-slim.
# Refresh with: docker pull node:22-slim && docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS base
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
# __SDP_RT_*__ defaults are placeholders swapped at container start by docker/entrypoint.sh.
ARG NEXT_PUBLIC_API_BASE_URL
ARG NEXT_PUBLIC_SDP_API_BASE_URL=__SDP_RT_NEXT_PUBLIC_SDP_API_BASE_URL__
ARG NEXT_PUBLIC_SDP_DOCS_URL=__SDP_RT_NEXT_PUBLIC_SDP_DOCS_URL__
ARG NEXT_PUBLIC_SOLANA_NETWORK=__SDP_RT_NEXT_PUBLIC_SOLANA_NETWORK__
ARG NEXT_PUBLIC_SENTRY_DSN
ARG NEXT_PUBLIC_ENABLE_NETWORK_DEBUG
ARG NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=__SDP_RT_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY__
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

# Opt into the Next.js standalone output tree. Gated in next.config.ts so
# non-Docker `next build` runs (Vercel preview, Playwright, local dev)
# don't pay for an unused .next/standalone artifact.
ENV NEXT_BUILD_STANDALONE=1

# Fail fast on missing NEXT_PUBLIC_* that are required for the app to function.
# These are baked into the client bundle at build time, so a missing value
# silently ships an empty string and the container starts "healthy" but every
# request fails — a debugging nightmare for self-hosted operators.
#
#  - SDP_API_BASE_URL / API_BASE_URL: api-playground + sdp-api client
#  - CLERK_PUBLISHABLE_KEY:           Clerk middleware throws 500 on every hit
#
# Whitespace is stripped before the empty check so callers can't slip a
# "   " value past validation and bake it into the bundle.
RUN sdp_api="$(printf %s "$NEXT_PUBLIC_SDP_API_BASE_URL" | tr -d '[:space:]')"; \
    legacy_api="$(printf %s "$NEXT_PUBLIC_API_BASE_URL" | tr -d '[:space:]')"; \
    clerk_key="$(printf %s "$NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY" | tr -d '[:space:]')"; \
    if [ -z "$sdp_api" ] && [ -z "$legacy_api" ]; then \
      echo "ERROR: pass --build-arg NEXT_PUBLIC_SDP_API_BASE_URL=<url> (or NEXT_PUBLIC_API_BASE_URL) — required for the API playground and sdp-api client." >&2; \
      exit 1; \
    fi; \
    if [ -z "$clerk_key" ]; then \
      echo "ERROR: pass --build-arg NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_... — Clerk SDK throws on missing publishableKey and the app becomes unreachable." >&2; \
      exit 1; \
    fi

# Sentry sourcemap upload is gated on SENTRY_AUTH_TOKEN. The secret is mounted
# only for the duration of this RUN and never written to a layer. If the
# secret is not provided the build still succeeds; sourcemaps just aren't
# uploaded.
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    pnpm --filter sdp-web build

# ── Runtime: slim image with only the standalone output ────────────────────
FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

# Apply OS-level security patches not yet in the pinned base image.
# This layer is cached — rebuild with --no-cache to pick up new fixes.
RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

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

ENV SDP_INJECT_DIRS=/app/apps/sdp-web/.next
COPY --chmod=0755 apps/sdp-web/docker/entrypoint.sh /app/entrypoint.sh
COPY apps/sdp-web/docker/inject-public-env.mjs /app/inject-public-env.mjs

# Provenance metadata for image registries / `docker image inspect`. Pass
# GIT_SHA at build time (e.g. --build-arg GIT_SHA=$(git rev-parse HEAD)) so
# published images carry the exact source revision. IMAGE_SOURCE is
# overridable so forks/redistributors can point at their own repository.
ARG GIT_SHA=""
ARG IMAGE_SOURCE="https://github.com/solana-foundation/solana-developer-platform"
LABEL org.opencontainers.image.title="sdp-web" \
      org.opencontainers.image.description="Solana Developer Platform — web (dashboard, API playground, docs proxy)" \
      org.opencontainers.image.source="$IMAGE_SOURCE" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Solana Foundation"

USER nextjs
EXPOSE 3000

# Liveness for plain `docker run`/compose. k8s ignores HEALTHCHECK and uses
# pod-level probes, so this is harmless there. `status<500` (not `r.ok`)
# because liveness means "the HTTP layer is up" — any 2xx/3xx/4xx response
# proves the Node process is alive and serving, even if a specific route
# returns 4xx for config reasons. 5xx is the only signal of a dead app.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/app/entrypoint.sh"]
CMD ["node", "apps/sdp-web/server.js"]
