#!/usr/bin/env bash
set -euo pipefail
git diff --name-only "$1" "$2" \
  | { grep -E '^(apps/sdp-api/|packages/|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|\.github/workflows/deploy(-sdp-api-gcp(-prod|-stage)?)?\.yml|\.github/workflows/sdp-stage-smoke\.yml)' || [[ $? == 1 ]]; }
