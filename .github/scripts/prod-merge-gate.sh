#!/usr/bin/env bash
# Decide whether a merge to main may deploy to prod.
#
# Schema changes ship through a release: migrations stay human-reviewed and
# human-run, and merge deploys never execute the migrate job. So a merge whose
# migrations directory differs from the last v* release tag is held until that
# release is cut. Run from a checkout with full history and tags.
#
# stdout: "open", or the reason for the hold.
# exit:   0 open, 2 held, anything else = could not evaluate (callers fail closed).
set -euo pipefail

MIGRATIONS_DIR="apps/sdp-api/src/db/migrations"

last_release="$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)"
if [[ -z "${last_release}" ]]; then
  echo "no v* release tag reachable from HEAD"
  exit 2
fi

changed="$(git diff --name-only "${last_release}..HEAD" -- "${MIGRATIONS_DIR}" | wc -l | tr -d ' ')"
if [[ "${changed}" -gt 0 ]]; then
  noun="files"
  [[ "${changed}" -eq 1 ]] && noun="file"
  echo "${changed} migration ${noun} changed since ${last_release}"
  exit 2
fi

echo "open"
