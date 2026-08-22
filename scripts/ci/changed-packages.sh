#!/usr/bin/env bash
# Prints the space-separated list of changed workspace packages (apps/<name> or
# packages/<name>) between BASE_REF (default origin/main) and HEAD. Paths are
# consumed as NUL-delimited records so an embedded newline cannot forge a
# record boundary, and package directory names are restricted to
# [A-Za-z0-9_.-] so a hostile file path can never smuggle shell
# metacharacters into the output.
set -euo pipefail

BASE_REF="${BASE_REF:-origin/main}"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

git diff --name-only -z "${BASE_REF}...HEAD" > "$TMP"

declare -A seen=()
while IFS= read -r -d '' path; do
  if [[ "$path" =~ ^(apps|packages)/([A-Za-z0-9_.-]+)/ ]]; then
    seen["${BASH_REMATCH[1]}/${BASH_REMATCH[2]}"]=1
  fi
done < "$TMP"

if [ "${#seen[@]}" -gt 0 ]; then
  printf '%s\n' "${!seen[@]}" | sort -u | tr '\n' ' ' | sed 's/ $//'
fi
