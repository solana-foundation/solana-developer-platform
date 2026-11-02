#!/usr/bin/env bash
set -euo pipefail

[[ "${TARGET}" == "prod" || "${TARGET}" == "stage" ]] || { echo 'Invalid target.' >&2; exit 1; }
[[ "${ACTION}" == "status" || "${ACTION}" == "suspend" || "${ACTION}" == "resume" ]] || { echo 'Invalid action.' >&2; exit 1; }
[[ "${OPERATOR}" =~ ^[A-Za-z0-9-]{1,39}$ ]] || { echo 'Invalid operator.' >&2; exit 1; }
[[ "${ORGANIZATION_ID}" =~ ^[A-Za-z0-9_-]{1,64}$ ]] || { echo 'Invalid organization id.' >&2; exit 1; }

args=(organization-control "${ACTION}" --organization-id "${ORGANIZATION_ID}")
if [[ "${ACTION}" != "status" ]]; then
  # The Cloud Run args transport uses | delimiters. Exclude delimiters,
  # shell substitution, quotes and control characters from operator text.
  text_re='^[A-Za-z0-9][A-Za-z0-9 ._,:;/#()-]{3,199}$'
  [[ "${REASON}" =~ ${text_re} ]] || { echo 'Reason must be 4-200 safe printable characters.' >&2; exit 1; }
  [[ "${TICKET}" =~ ^[A-Z]{2,6}-[0-9]{1,6}$ ]] || { echo 'A Linear ticket is required.' >&2; exit 1; }
  args+=(--operator "github:${OPERATOR}" --reason "${REASON}" --ticket "${TICKET}")
fi
if [[ "${ACTION}" == "resume" ]]; then
  [[ "${EXPECTED_VERSION}" =~ ^[0-9]{1,10}$ ]] || { echo 'Resume requires the current version from status.' >&2; exit 1; }
  args+=(--expected-version "${EXPECTED_VERSION}")
elif [[ -n "${EXPECTED_VERSION}" ]]; then
  echo 'Only resume accepts an expected version.' >&2; exit 1
fi
joined="$(IFS='|'; echo "${args[*]}")"
echo "args=${joined}" >> "${GITHUB_OUTPUT}"
gated=false
if [[ "${TARGET}" == "prod" && "${ACTION}" == "resume" ]]; then gated=true; fi
echo "gated=${gated}" >> "${GITHUB_OUTPUT}"
printf 'Target: %s\n\n    incident-ops %s\n' "${TARGET}" "${args[*]}" >> "${GITHUB_STEP_SUMMARY}"
if [[ "${gated}" == "true" ]]; then
  echo 'Production resume waits for release-production approval.' >> "${GITHUB_STEP_SUMMARY}"
fi
