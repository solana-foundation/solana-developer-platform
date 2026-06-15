#!/usr/bin/env bash
# Build a config-baked Kora image and deploy it to the kora-<ENV> Cloud Run service.
# Secrets/env come from Doppler — run this under `doppler run`, e.g.:
#   ENV=sandbox PROJECT=trading-prod-494016 \
#     doppler run --project kora --config sandbox -- ./deploy.sh
# Only image + env are changed here; the rest of the service is Terraform-managed (ignore_changes).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV="${ENV:?ENV=sandbox|devnet|mainnet}"
PROJECT="${PROJECT:?PROJECT=<gcp project id>}"
REGION="${REGION:-us-central1}"
KORA_BASE="${KORA_BASE:-ghcr.io/solana-foundation/kora:latest}"

: "${RPC_URL:?set via Doppler}"
: "${KORA_GCP_KMS_KEY_NAME:?set via Doppler}"
: "${KORA_GCP_KMS_PUBLIC_KEY:?set via Doppler}"

SERVICE="kora-${ENV}"
TAG="$(git -C "$SCRIPT_DIR" rev-parse --short HEAD 2>/dev/null || echo manual)"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${SERVICE}/kora:${TAG}"

case "$ENV" in
  mainnet) KCFG=kora.mainnet.toml; SCFG=signers.mainnet.toml ;;
  devnet)  KCFG=kora.devnet.toml;  SCFG=signers.devnet.toml ;;
  sandbox) KCFG=kora.devnet.toml;  SCFG=signers.mainnet.toml ;; # devnet RPC + KMS signer
  *) echo "unknown ENV: $ENV" >&2; exit 1 ;;
esac

gcloud builds submit "$SCRIPT_DIR" --project "$PROJECT" --config "$SCRIPT_DIR/cloudbuild.yaml" \
  --substitutions=_IMAGE="$IMAGE",_BASE="$KORA_BASE",_KCFG="$KCFG",_SCFG="$SCFG"

ENV_VARS="^##^RUST_LOG=info##RPC_URL=${RPC_URL}##KORA_GCP_KMS_KEY_NAME=${KORA_GCP_KMS_KEY_NAME}##KORA_GCP_KMS_PUBLIC_KEY=${KORA_GCP_KMS_PUBLIC_KEY}"
[ -n "${KORA_REDIS_URL:-}" ] && ENV_VARS="${ENV_VARS}##KORA_REDIS_URL=${KORA_REDIS_URL}"
[ -n "${KORA_API_KEY:-}" ] && ENV_VARS="${ENV_VARS}##KORA_API_KEY=${KORA_API_KEY}"

gcloud run services update "$SERVICE" --project "$PROJECT" --region "$REGION" \
  --image "$IMAGE" --update-env-vars "$ENV_VARS"

echo "Deployed $IMAGE to $SERVICE"
