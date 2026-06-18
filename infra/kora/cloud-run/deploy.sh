#!/usr/bin/env bash
# Build a config-baked Kora image and deploy it to the kora-<ENV> Cloud Run service.
# Secrets/env come from Doppler — run this under `doppler run`, e.g.:
#   ENV=mainnet PROJECT=trading-prod-494016 \
#     doppler run --project kora --config mainnet -- ./deploy.sh
# Only image + env are changed here; the rest of the service is Terraform-managed (ignore_changes).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${ENV:?ENV=devnet|mainnet}"
PROJECT="${PROJECT:?PROJECT=<gcp project id>}"
REGION="${REGION:-us-central1}"

: "${RPC_URL:?set via Doppler}"
: "${KORA_GCP_KMS_KEY_NAME:?set via Doppler}"
: "${KORA_GCP_KMS_PUBLIC_KEY:?set via Doppler}"

# Never deploy mainnet without app-level auth — the Cloud Run service allows unauthenticated invoke,
# so a missing key = an open, drainable paymaster.
if [ "$ENV" = "mainnet" ] && [ -z "${KORA_API_KEY:-}" ]; then
  echo "refusing to deploy mainnet without KORA_API_KEY set" >&2
  exit 1
fi

# Mainnet config has cache + usage_limit fail-closed, so a missing Redis URL rejects every request.
if [ "$ENV" = "mainnet" ] && [ -z "${KORA_REDIS_URL:-}" ]; then
  echo "refusing to deploy mainnet without KORA_REDIS_URL set" >&2
  exit 1
fi

SERVICE="kora-${ENV}"
TAG="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo manual)$(git -C "$SCRIPT_DIR" diff --quiet 2>/dev/null || echo -dirty)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${SERVICE}/kora:${TAG}"

case "$ENV" in
  mainnet) KCFG=kora.mainnet.toml; SCFG=signers.mainnet.toml ;;
  devnet)  KCFG=kora.devnet.toml;  SCFG=signers.devnet.toml ;;
  *) echo "unknown ENV: $ENV" >&2; exit 1 ;;
esac

gcloud builds submit "$SCRIPT_DIR" --project "$PROJECT" --config "$SCRIPT_DIR/cloudbuild.yaml" \
  --substitutions=_IMAGE="$IMAGE",_KCFG="$KCFG",_SCFG="$SCFG"

ENV_VARS="^##^RUST_LOG=info##RPC_URL=${RPC_URL}##KORA_GCP_KMS_KEY_NAME=${KORA_GCP_KMS_KEY_NAME}##KORA_GCP_KMS_PUBLIC_KEY=${KORA_GCP_KMS_PUBLIC_KEY}"
[ -n "${KORA_REDIS_URL:-}" ] && ENV_VARS="${ENV_VARS}##KORA_REDIS_URL=${KORA_REDIS_URL}"
[ -n "${KORA_API_KEY:-}" ] && ENV_VARS="${ENV_VARS}##KORA_API_KEY=${KORA_API_KEY}"
[ -n "${JUPITER_API_KEY:-}" ] && ENV_VARS="${ENV_VARS}##JUPITER_API_KEY=${JUPITER_API_KEY}"

gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" --update-env-vars "$ENV_VARS"

echo "Deployed $IMAGE to $SERVICE"
