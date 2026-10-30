#!/usr/bin/env bash
# Executes the incident-ops Cloud Run job with a |-delimited args override.
# Shared by .github/workflows/incident-*.yml. Expects:
#   PROJECT_ID, REGION, OPS_JOB, MIGRATE_JOB, ARGS (validated by the caller)
set -euo pipefail

: "${PROJECT_ID:?}" "${REGION:?}" "${OPS_JOB:?}" "${MIGRATE_JOB:?}" "${ARGS:?}"

scope=(--region "${REGION}" --project "${PROJECT_ID}")

# Pin the ops job to the image whose migrations prod last applied, so the script
# always runs against the schema it was built for.
image="$(gcloud run jobs describe "${MIGRATE_JOB}" "${scope[@]}" \
  --format 'value(spec.template.spec.template.spec.containers[0].image)')"
if [[ -z "${image}" ]]; then
  echo "Could not resolve the migrate job's image." >&2
  exit 1
fi
current="$(gcloud run jobs describe "${OPS_JOB}" "${scope[@]}" \
  --format 'value(spec.template.spec.template.spec.containers[0].image)')"
if [[ "${current}" != "${image}" ]]; then
  gcloud run jobs update "${OPS_JOB}" "${scope[@]}" --image "${image}"
fi

echo "Executing ${OPS_JOB}: incident-ops ${ARGS//|/ }"
execute_status=0
execution="$(gcloud run jobs execute "${OPS_JOB}" "${scope[@]}" \
  --args "^|^${ARGS}" --wait --format 'value(metadata.name)')" || execute_status=$?

# Surface the script's JSON output (best effort: logs can lag or be unreadable
# to this service account; the execution link always works).
if [[ -n "${execution:-}" ]]; then
  echo "Execution: ${execution}"
  {
    printf '## %s\n\n' "${execution}"
    printf 'https://console.cloud.google.com/run/jobs/executions/details/%s/%s/logs?project=%s\n\n```\n' \
      "${REGION}" "${execution}" "${PROJECT_ID}"
  } >> "${GITHUB_STEP_SUMMARY}"
  sleep 10
  gcloud logging read \
    "resource.type=\"cloud_run_job\" AND resource.labels.job_name=\"${OPS_JOB}\" AND labels.\"run.googleapis.com/execution_name\"=\"${execution}\"" \
    --project "${PROJECT_ID}" --limit 300 --order asc \
    --format 'value(textPayload)' >> "${GITHUB_STEP_SUMMARY}" || true
  printf '```\n' >> "${GITHUB_STEP_SUMMARY}"
fi

exit "${execute_status}"
