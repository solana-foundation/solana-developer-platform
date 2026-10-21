#!/usr/bin/env bash
# `pnpm dev`'s dev:kora task: follows both local Koras' logs beside the rest of the
# stack. up.sh has already started them; the mainnet Kora exists only with a fork.
set -euo pipefail

trap 'kill $(jobs -p) 2>/dev/null' EXIT INT TERM

# Each job is `docker logs` itself, so the trap reaches it; awk ends at its EOF.
follow() {
  docker logs -f --tail 20 "$1" > >(awk -v prefix="[$2] " '{ print prefix $0; fflush() }') 2>&1 &
}

follow kora-devnet-kora-1 devnet
if docker inspect kora-mainnet-kora-1 >/dev/null 2>&1; then
  follow kora-mainnet-kora-1 mainnet
fi
wait
