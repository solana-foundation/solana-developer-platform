#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${1:-}"

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing env file: $ENV_FILE" >&2
    exit 1
  fi
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

require() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

require_file_if_set() {
  local name="$1"
  local path="${!name:-}"
  if [[ -n "$path" && ! -f "$path" ]]; then
    echo "$name points at a missing file: $path" >&2
    exit 1
  fi
}

ensure_secret() {
  local secret_name="$1"
  local source_file="$2"

  if ! gcloud secrets describe "$secret_name" >/dev/null 2>&1; then
    if [[ -z "$source_file" ]]; then
      echo "Secret $secret_name does not exist and no source file was provided." >&2
      exit 1
    fi
    gcloud secrets create "$secret_name" --replication-policy=automatic
  fi

  if [[ -n "$source_file" ]]; then
    gcloud secrets versions add "$secret_name" --data-file="$source_file"
  fi

  gcloud secrets add-iam-policy-binding "$secret_name" \
    --member="serviceAccount:${COSIGNER_SERVICE_ACCOUNT_EMAIL}" \
    --role=roles/secretmanager.secretAccessor \
    --quiet >/dev/null
}

for var in \
  GCP_PROJECT_ID \
  GCP_REGION \
  COSIGNER_SERVICE_NAME \
  COSIGNER_ENVIRONMENT \
  COSIGNER_IMAGE \
  COSIGNER_INGRESS \
  COSIGNER_CONFIG_SECRET \
  COSIGNER_CONFIG_SECRET_VERSION \
  COSIGNER_PRIVATE_KEY_SECRET \
  COSIGNER_PRIVATE_KEY_SECRET_VERSION \
  COSIGNER_AUTH_TOKEN_SECRET \
  COSIGNER_AUTH_TOKEN_SECRET_VERSION; do
  require "$var"
done

COSIGNER_SERVICE_ACCOUNT="${COSIGNER_SERVICE_ACCOUNT:-utila-cosigner-runtime}"
COSIGNER_SERVICE_ACCOUNT_EMAIL="${COSIGNER_SERVICE_ACCOUNT_EMAIL:-${COSIGNER_SERVICE_ACCOUNT}@${GCP_PROJECT_ID}.iam.gserviceaccount.com}"
COSIGNER_MIN_SCALE="${COSIGNER_MIN_SCALE:-1}"
COSIGNER_MAX_SCALE="${COSIGNER_MAX_SCALE:-3}"
COSIGNER_CONTAINER_PORT="${COSIGNER_CONTAINER_PORT:-8080}"
COSIGNER_ALLOW_UNAUTHENTICATED="${COSIGNER_ALLOW_UNAUTHENTICATED:-false}"

if [[ "$COSIGNER_ALLOW_UNAUTHENTICATED" != "true" && "$COSIGNER_ALLOW_UNAUTHENTICATED" != "false" ]]; then
  echo "COSIGNER_ALLOW_UNAUTHENTICATED must be true or false." >&2
  exit 1
fi

export \
  GCP_PROJECT_ID \
  GCP_REGION \
  COSIGNER_SERVICE_NAME \
  COSIGNER_ENVIRONMENT \
  COSIGNER_IMAGE \
  COSIGNER_INGRESS \
  COSIGNER_SERVICE_ACCOUNT_EMAIL \
  COSIGNER_MIN_SCALE \
  COSIGNER_MAX_SCALE \
  COSIGNER_CONTAINER_PORT \
  COSIGNER_CONFIG_SECRET \
  COSIGNER_CONFIG_SECRET_VERSION \
  COSIGNER_PRIVATE_KEY_SECRET \
  COSIGNER_PRIVATE_KEY_SECRET_VERSION \
  COSIGNER_AUTH_TOKEN_SECRET \
  COSIGNER_AUTH_TOKEN_SECRET_VERSION

require_file_if_set COSIGNER_CONFIG_FILE
require_file_if_set COSIGNER_PRIVATE_KEY_FILE
require_file_if_set COSIGNER_AUTH_TOKEN_FILE

gcloud config set project "$GCP_PROJECT_ID" >/dev/null

if ! gcloud iam service-accounts describe "$COSIGNER_SERVICE_ACCOUNT_EMAIL" >/dev/null 2>&1; then
  gcloud iam service-accounts create "$COSIGNER_SERVICE_ACCOUNT" \
    --display-name="Utila co-signer runtime"
fi

ensure_secret "$COSIGNER_CONFIG_SECRET" "${COSIGNER_CONFIG_FILE:-}"
ensure_secret "$COSIGNER_PRIVATE_KEY_SECRET" "${COSIGNER_PRIVATE_KEY_FILE:-}"
ensure_secret "$COSIGNER_AUTH_TOKEN_SECRET" "${COSIGNER_AUTH_TOKEN_FILE:-}"

RENDERED="$(mktemp "${TMPDIR:-/tmp}/utila-cosigner-service.XXXXXX.yaml")"
trap 'rm -f "$RENDERED"' EXIT

node - "$SCRIPT_DIR/service.template.yaml" "$RENDERED" <<'JS'
const fs = require("node:fs");

const [templatePath, outputPath] = process.argv.slice(2);
const keys = [
  "COSIGNER_SERVICE_NAME",
  "COSIGNER_ENVIRONMENT",
  "COSIGNER_INGRESS",
  "COSIGNER_MIN_SCALE",
  "COSIGNER_MAX_SCALE",
  "COSIGNER_SERVICE_ACCOUNT_EMAIL",
  "COSIGNER_IMAGE",
  "COSIGNER_CONTAINER_PORT",
  "COSIGNER_CONFIG_SECRET",
  "COSIGNER_CONFIG_SECRET_VERSION",
  "COSIGNER_PRIVATE_KEY_SECRET",
  "COSIGNER_PRIVATE_KEY_SECRET_VERSION",
  "COSIGNER_AUTH_TOKEN_SECRET",
  "COSIGNER_AUTH_TOKEN_SECRET_VERSION",
];

let content = fs.readFileSync(templatePath, "utf8");
for (const key of keys) {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing ${key}`);
  }
  content = content.split(`__${key}__`).join(value);
}

fs.writeFileSync(outputPath, content);
JS

gcloud run services replace "$RENDERED" --region "$GCP_REGION"

if [[ "$COSIGNER_ALLOW_UNAUTHENTICATED" == "true" ]]; then
  gcloud run services add-iam-policy-binding "$COSIGNER_SERVICE_NAME" \
    --region "$GCP_REGION" \
    --member=allUsers \
    --role=roles/run.invoker \
    --quiet >/dev/null
else
  gcloud run services remove-iam-policy-binding "$COSIGNER_SERVICE_NAME" \
    --region "$GCP_REGION" \
    --member=allUsers \
    --role=roles/run.invoker \
    --quiet >/dev/null 2>&1 || true
fi

SERVICE_URL="$(gcloud run services describe "$COSIGNER_SERVICE_NAME" \
  --region "$GCP_REGION" \
  --format='value(status.url)')"

cat <<EOF
Utila co-signer Cloud Run service deployed.

Service: ${COSIGNER_SERVICE_NAME}
Region:  ${GCP_REGION}
URL:     ${SERVICE_URL}

Use this URL with the Utila SDP integration once its runtime wiring is present.
EOF
