#!/usr/bin/env bash
# Prints the space-separated list of changed workspace packages (apps/<name> or
# packages/<name>) between BASE_REF (default origin/main) and HEAD. Package
# directory names are restricted to [A-Za-z0-9_.-] so a hostile file path can
# never smuggle shell metacharacters into the output.
set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"

git diff --name-only -z "${BASE_REF}...HEAD" \
  | tr '\0' '\n' \
  | { LC_ALL=C grep -E '^(apps|packages)/[A-Za-z0-9_.-]+/' || true; } \
  | awk -F/ '{print $1 "/" $2}' \
  | sort -u \
  | tr '\n' ' ' \
  | sed 's/ $//'
