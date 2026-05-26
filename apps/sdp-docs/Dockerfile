# syntax=docker/dockerfile:1.7
#
# Build from the monorepo root:
#   docker build -f apps/sdp-docs/Dockerfile -t sdp-docs .

# Bump with: docker pull node:22-slim && docker inspect --format='{{index .RepoDigests 0}}' node:22-slim
FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@10.16.0 --activate

# sdp-api is in scope because the docs build runs `openapi:generate` from it via tsx.
FROM base AS deps
WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.json ./
COPY apps/sdp-docs/package.json ./apps/sdp-docs/
COPY apps/sdp-api/package.json ./apps/sdp-api/
COPY packages/sdp-types/package.json ./packages/sdp-types/
COPY patches ./patches

RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter sdp-docs... --filter @sdp/api...

FROM base AS builder
WORKDIR /repo

COPY --from=deps /repo /repo
COPY apps/sdp-docs ./apps/sdp-docs
COPY apps/sdp-api ./apps/sdp-api
COPY packages/sdp-types ./packages/sdp-types

# Baked into the client bundle; defaults live in @sdp/types.
ARG NEXT_PUBLIC_SDP_WEB_URL
ARG NEXT_PUBLIC_SDP_DOCS_URL
ARG NEXT_PUBLIC_SDP_API_URL
ENV NEXT_PUBLIC_SDP_WEB_URL=$NEXT_PUBLIC_SDP_WEB_URL \
    NEXT_PUBLIC_SDP_DOCS_URL=$NEXT_PUBLIC_SDP_DOCS_URL \
    NEXT_PUBLIC_SDP_API_URL=$NEXT_PUBLIC_SDP_API_URL \
    NEXT_BUILD_STANDALONE=1

RUN pnpm --filter sdp-docs build

FROM node:22-slim@sha256:689c11043dad91472750cd824c97dd5e2318e9dd6f954e492fe7af0135d33ceb AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system --gid 1001 nodejs \
 && useradd --system --uid 1001 --gid nodejs nextjs

# Tracing skips .next/static and public; copy them alongside standalone.
COPY --from=builder --chown=nextjs:nodejs /repo/apps/sdp-docs/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /repo/apps/sdp-docs/.next/static ./apps/sdp-docs/.next/static
COPY --from=builder --chown=nextjs:nodejs /repo/apps/sdp-docs/public ./apps/sdp-docs/public

ARG GIT_SHA=""
ARG IMAGE_SOURCE="https://github.com/solana-foundation/solana-developer-platform"
LABEL org.opencontainers.image.title="sdp-docs" \
      org.opencontainers.image.description="Solana Developer Platform — documentation site" \
      org.opencontainers.image.source="$IMAGE_SOURCE" \
      org.opencontainers.image.revision="$GIT_SHA" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.vendor="Solana Foundation"

USER nextjs
EXPOSE 3001

# status<500: liveness only needs the process to respond, not a specific route to be configured.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/sdp-docs/server.js"]
