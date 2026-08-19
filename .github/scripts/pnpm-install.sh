#!/usr/bin/env bash
#
# Workspace install for CI, degrading when the private npm scope is unreachable.
#
# ── Why this exists ─────────────────────────────────────────────────────────
# `packages/sdp-veda` depends on `@vedatech/svm-sdk`, which is published to a
# PRIVATE npm scope. Every other package in this workspace is public. Repository
# secrets are not readable from a FORKED pull request, and SDP accepts provider
# integrations from forks (CONTRIBUTING.md → "Provider Contributions"), so an
# install that simply required the token would turn every external contribution
# red on a dependency it has nothing to do with.
#
# Deselecting the one project that owns the private package is enough: pnpm
# never requests tarballs for a deselected workspace project, so the rest of the
# install proceeds with no credential at all. Measured against pnpm 10.16.0 —
# with the token absent, the unfiltered install fails `ERR_PNPM_FETCH_404` on
# `@vedatech/svm-sdk` and the filtered one completes from the lockfile.
#
# Callers pass no arguments; extra arguments are forwarded to pnpm.
#
# Reads `NPM_TOKEN` from the environment (the job supplies it from the
# repository secret) and never prints it. Writes `CI_HAS_NPM_TOKEN` to
# `$GITHUB_ENV` so later steps can skip work that genuinely needs the SDK —
# `jobs.<id>.if` cannot see a secret, so a step-level condition on this value is
# how a job answers "was the private half installed?".
set -euo pipefail

github_env="${GITHUB_ENV:-/dev/null}"

if [ -n "${NPM_TOKEN:-}" ]; then
  echo "CI_HAS_NPM_TOKEN=true" >>"${github_env}"
  exec pnpm install --frozen-lockfile "$@"
fi

echo "CI_HAS_NPM_TOKEN=false" >>"${github_env}"
echo "::notice title=No private registry access::NPM_TOKEN is unavailable — a forked pull request cannot read repository secrets, and the secret may not be provisioned yet. Installing without @sdp/veda; checks that need @vedatech/svm-sdk are skipped and reported individually."
exec pnpm install --frozen-lockfile --filter '!@sdp/veda' "$@"
