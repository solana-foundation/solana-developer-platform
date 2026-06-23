#!/usr/bin/env bash
# Deploy Kora by pinned image tag. Cloud Run can't pull from ghcr.io, so mirror the pinned upstream
# tag into this project's Artifact Registry (kora-<ENV> repo) and point the service at it. Config +
# signers are mounted from Secret Manager (Terraform-owned) and the container args are set in
# Terraform too — this script only updates the image + env. Run under `doppler run` so the
# env-scoped KORA_<ENV>_* secrets are present.
#
#   ENV=devnet PROJECT=solana-developer-platform KORA_TAG=v1.2.3 \
#     doppler run --project solana-developer-platform --config prd -- ./deploy.sh
set -euo pipefail

ENV="${ENV:?ENV=devnet|mainnet}"
PROJECT="${PROJECT:?PROJECT=<gcp project id>}"
REGION="${REGION:-us-central1}"
KORA_TAG="${KORA_TAG:?KORA_TAG=<immutable git-sha tag>}"
GHCR_REPO="${GHCR_REPO:-ghcr.io/solana-foundation/kora}"

# Immutable tags only — refuse mutable tags so "what's deployed" is always traceable to one commit.
case "$KORA_TAG" in
  ""|latest|edge|beta) echo "refusing mutable/empty image tag '$KORA_TAG' — pin an immutable :<git-sha>" >&2; exit 1 ;;
esac

# Resolve env-scoped Doppler secrets (KORA_MAINNET_* / KORA_DEVNET_*) to the names Kora reads.
EP="KORA_$(printf '%s' "$ENV" | tr '[:lower:]' '[:upper:]')_"
RPC_URL="$(printenv "${EP}RPC_URL" 2>/dev/null || true)"
KORA_GCP_KMS_KEY_NAME="$(printenv "${EP}GCP_KMS_KEY_NAME" 2>/dev/null || true)"
KORA_GCP_KMS_PUBLIC_KEY="$(printenv "${EP}GCP_KMS_PUBLIC_KEY" 2>/dev/null || true)"
KORA_REDIS_URL="$(printenv "${EP}REDIS_URL" 2>/dev/null || true)"
KORA_API_KEY="$(printenv "${EP}API_KEY" 2>/dev/null || true)"
JUPITER_API_KEY="$(printenv "${EP}JUPITER_API_KEY" 2>/dev/null || true)"

: "${RPC_URL:?set via Doppler (${EP}RPC_URL)}"
: "${KORA_GCP_KMS_KEY_NAME:?set via Doppler (${EP}GCP_KMS_KEY_NAME)}"
: "${KORA_GCP_KMS_PUBLIC_KEY:?set via Doppler (${EP}GCP_KMS_PUBLIC_KEY)}"

# Fail closed on mainnet: the Cloud Run service allows unauthenticated invoke, so a missing API key
# is an open/drainable paymaster; and the mainnet config is fail-closed on Redis.
if [ "$ENV" = "mainnet" ] && [ -z "${KORA_API_KEY:-}" ]; then
  echo "refusing to deploy mainnet without KORA_API_KEY set" >&2; exit 1
fi
if [ "$ENV" = "mainnet" ] && [ -z "${KORA_REDIS_URL:-}" ]; then
  echo "refusing to deploy mainnet without KORA_REDIS_URL set" >&2; exit 1
fi

# Mirror the pinned ghcr tag into Artifact Registry, then deploy that.
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
AR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/kora-${ENV}/kora:${KORA_TAG}"
# Resolve the tag to an immutable digest first, log it, and copy by digest — so the exact bits
# deployed are auditable and a mutated/overwritten upstream tag can't silently change the mirror.
DIGEST="$(gcrane digest "${GHCR_REPO}:${KORA_TAG}")"
echo "Resolved ${GHCR_REPO}:${KORA_TAG} -> ${DIGEST}"
echo "Mirroring ${GHCR_REPO}@${DIGEST} -> ${AR_IMAGE}"
gcrane cp "${GHCR_REPO}@${DIGEST}" "${AR_IMAGE}"

SERVICE="kora-${ENV}"
ENV_VARS="^##^RUST_LOG=info##RPC_URL=${RPC_URL}##KORA_GCP_KMS_KEY_NAME=${KORA_GCP_KMS_KEY_NAME}##KORA_GCP_KMS_PUBLIC_KEY=${KORA_GCP_KMS_PUBLIC_KEY}"
[ -n "${KORA_REDIS_URL:-}" ] && ENV_VARS="${ENV_VARS}##KORA_REDIS_URL=${KORA_REDIS_URL}"
[ -n "${KORA_API_KEY:-}" ] && ENV_VARS="${ENV_VARS}##KORA_API_KEY=${KORA_API_KEY}"
[ -n "${JUPITER_API_KEY:-}" ] && ENV_VARS="${ENV_VARS}##JUPITER_API_KEY=${JUPITER_API_KEY}"

gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --image "$AR_IMAGE" --update-env-vars "$ENV_VARS"

echo "Deployed ${AR_IMAGE} to ${SERVICE}"
