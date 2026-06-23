#!/usr/bin/env bash
# Create or update the SDP Cloud Run failure log-based metric in GCP.
# Idempotent: creates if missing, updates otherwise.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PROJECT=solana-developer-platform
NAME=sdp_cloud_run_service_failures
if gcloud logging metrics describe "$NAME" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud logging metrics update "$NAME" --project "$PROJECT" \
    --config-from-file=log-metric-cloud-run-failures.json
else
  gcloud logging metrics create "$NAME" --project "$PROJECT" \
    --config-from-file=log-metric-cloud-run-failures.json
fi
