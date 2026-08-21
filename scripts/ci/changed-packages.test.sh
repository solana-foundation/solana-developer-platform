#!/usr/bin/env bash
# Regression fixture for changed-packages.sh: a pull request may contain files
# whose names embed shell metacharacters. The detector must neither execute
# them nor let them reach its output.
set -euo pipefail

SCRIPT="$(cd "$(dirname "$0")" && pwd)/changed-packages.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

cd "$TMP"
git init -q -b main
git -c user.name=fixture -c user.email=fixture@invalid commit -q --allow-empty -m base
git branch -f baseline

mkdir -p 'apps/legit'
echo x > 'apps/legit/index.ts'
mkdir -p 'apps/$(touch INJECTED)'
echo x > 'apps/$(touch INJECTED)/index.ts'
mkdir -p 'packages/evil;rm -rf .'
echo x > 'packages/evil;rm -rf ./index.ts'
mkdir -p 'apps/nl
apps/forged'
echo x > 'apps/nl
apps/forged/index.ts'
git add -A
git -c user.name=fixture -c user.email=fixture@invalid commit -q -m change

OUTPUT="$(BASE_REF=baseline bash "$SCRIPT")"

if [ "$OUTPUT" != "apps/legit" ]; then
  echo "FAIL: expected only apps/legit, got: '$OUTPUT'" >&2
  exit 1
fi
if [ -e INJECTED ]; then
  echo "FAIL: malicious path was executed" >&2
  exit 1
fi

FILTERS=""
for pkg in $OUTPUT; do
  FILTERS="$FILTERS --filter ./$pkg"
done
if [ "$FILTERS" != " --filter ./apps/legit" ]; then
  echo "FAIL: filter assembly produced: '$FILTERS'" >&2
  exit 1
fi

echo "OK: malicious paths excluded, no execution, filters clean"
