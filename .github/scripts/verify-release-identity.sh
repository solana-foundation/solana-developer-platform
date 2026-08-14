#!/usr/bin/env bash

set -euo pipefail

if [[ "$#" -ne 2 ]]; then
  echo "Usage: $0 <release-tag> <release-sha>" >&2
  exit 2
fi

release_tag="$1"
release_sha="$2"

if [[ ! "${release_tag}" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "release-tag must use the vX.Y.Z format." >&2
  exit 1
fi

if [[ ! "${release_sha}" =~ ^[0-9a-f]{40}$ ]]; then
  echo "release-sha must be a lowercase 40-character Git SHA." >&2
  exit 1
fi

head_sha="$(git rev-parse HEAD)"
if [[ "${head_sha}" != "${release_sha}" ]]; then
  echo "Checked out ${head_sha}, expected release SHA ${release_sha}." >&2
  exit 1
fi

tag_sha="$(git rev-parse "${release_tag}^{commit}")"
if [[ "${tag_sha}" != "${release_sha}" ]]; then
  echo "${release_tag} resolves to ${tag_sha}, expected ${release_sha}." >&2
  exit 1
fi

if ! git show-ref --verify --quiet refs/remotes/origin/main; then
  echo "origin/main is unavailable; release provenance cannot be verified." >&2
  exit 1
fi

if ! git merge-base --is-ancestor "${release_sha}" refs/remotes/origin/main; then
  echo "${release_sha} is not contained in origin/main." >&2
  exit 1
fi

package_version="$(node -p "require('./package.json').version")"
tag_version="${release_tag#v}"
if [[ "${tag_version}" != "${package_version}" ]]; then
  echo "${release_tag} does not match package.json version ${package_version}." >&2
  exit 1
fi

echo "Verified ${release_tag} at ${release_sha} on origin/main."
