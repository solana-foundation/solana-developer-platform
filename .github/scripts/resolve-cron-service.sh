#!/usr/bin/env bash
# Prints the name of an environment's cron Cloud Run service, the always-on
# service that runs the Cron Definitions (ADR 0011).
#
#   resolve-cron-service.sh <prefix>     e.g. resolve-cron-service.sh sdp-prod
#
# Reads PROJECT_ID and REGION. Exits 3 when gcloud reports both names as not
# found, and 1 when neither can be read for any other reason. A deploy identity
# granted per service is refused, not told "not found", for a service that does
# not exist, so a failure on the first name always falls through to the second.
#
# TEMPORARY (PRO-2519): the service is being renamed from <prefix>-worker to
# <prefix>-cron, one environment at a time, as each environment's Terraform is
# applied. Until then a deploy may meet either name. Once every environment
# serves <prefix>-cron, delete this script and name the service directly.
set -euo pipefail

prefix="${1:?usage: resolve-cron-service.sh <prefix>}"
: "${PROJECT_ID:?PROJECT_ID is required}" "${REGION:?REGION is required}"

err="$(mktemp)"
trap 'rm -f "${err}" "${err}.all"' EXIT
status=3

for name in "${prefix}-cron" "${prefix}-worker"; do
  if gcloud run services describe "${name}" \
    --region "${REGION}" --project "${PROJECT_ID}" \
    --format='value(metadata.name)' >/dev/null 2>"${err}"; then
    echo "${name}"
    exit 0
  fi
  grep -qiE "NOT_FOUND|could not be found|cannot find" "${err}" || status=1
  cat "${err}" >>"${err}.all"
done

cat "${err}.all" >&2
echo "No cron service found in ${PROJECT_ID}: tried ${prefix}-cron and ${prefix}-worker." >&2
exit "${status}"
