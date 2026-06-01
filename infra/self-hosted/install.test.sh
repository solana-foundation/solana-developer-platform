#!/usr/bin/env bash
# End-to-end test for install.sh. Runs the script in clean ubuntu:24.04 containers,
# with a stubbed `docker` and the download source pointed at this repo's files.
# Requires a working local Docker. Usage: bash infra/self-hosted/install.test.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMG="ubuntu:24.04"
pass=0
fail=0
check() { # check <name> <condition-rc>
  if [ "$2" -eq 0 ]; then echo "  PASS: $1"; pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

# Common container preamble: install curl, lay down env, then run the scenario body ($1).
scenario() { # scenario <name> <docker-run-flags...> -- <in-container-bash>
  local name="$1"; shift
  local flags=(); while [ "$1" != "--" ]; do flags+=("$1"); shift; done; shift
  echo "[$name]"
  docker run --rm -v "$REPO:/src:ro" \
    -e SDP_INSTALL_BASE_URL="file:///src" -e INSTALL_VERSION="." \
    -e SDP_INSTALL_DIR="/root/sdp" \
    "${flags[@]}" "$IMG" bash -c "
      set -u
      apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq curl >/dev/null 2>&1
      $1
    "
}

# A fake docker that satisfies the preflight checks. Single-quoted on purpose: the
# $1/$2 must reach the stub file literally, not expand here.
# shellcheck disable=SC2016
DOCKER_STUB='mkdir -p /usr/local/bin; cat > /usr/local/bin/docker <<"EOF"
#!/bin/sh
[ "$1 $2" = "compose version" ] && { echo "Docker Compose version v2.29.0"; exit 0; }
exit 0
EOF
chmod +x /usr/local/bin/docker'

# 1. Docker missing -> clear error + non-zero exit, no files written.
# The body is single-quoted so $out/$rc/$? expand inside the container, not here.
# shellcheck disable=SC2016
if scenario "docker-missing" -- '
  out=$(bash /src/infra/self-hosted/install.sh 2>&1); rc=$?
  [ $rc -ne 0 ] && echo "$out" | grep -qi "docker is not installed" && [ ! -f /root/sdp/compose.yml ]
'; then check "exits non-zero with install-Docker message, writes nothing" 0
else check "exits non-zero with install-Docker message, writes nothing" 1; fi

# 2. Headless happy path -> compose.yml placed, CLI command printed, no open attempt.
if scenario "headless" -- "
  $DOCKER_STUB
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -eq 0 ] \
    && cmp -s /root/sdp/compose.yml /src/infra/self-hosted/compose.yml \
    && [ -f /root/sdp/.env.example ] \
    && echo \"\$out\" | grep -q 'node configure.js --out /out/.env' \
    && ! echo \"\$out\" | grep -qi 'opening the configurator'
"; then check "places compose.yml + .env.example, prints CLI handoff" 0
else check "places compose.yml + .env.example, prints CLI handoff" 1; fi

# 3. Desktop -> auto-open attempted (stub xdg-open records a marker).
if scenario "desktop" -e DISPLAY=:0 -- "
  $DOCKER_STUB
  printf '#!/bin/sh\ntouch /tmp/opened\n' > /usr/local/bin/xdg-open; chmod +x /usr/local/bin/xdg-open
  bash /src/infra/self-hosted/install.sh >/dev/null 2>&1
  [ -f /tmp/opened ]
"; then check "auto-opens the configurator page on a GUI host" 0
else check "auto-opens the configurator page on a GUI host" 1; fi

# 4. Idempotency -> existing .env and .env.example are preserved across a second run.
if scenario "idempotent" -- "
  $DOCKER_STUB
  mkdir -p /root/sdp
  printf 'KEEP=me\n' > /root/sdp/.env
  printf 'SENTINEL=keep\n' > /root/sdp/.env.example
  bash /src/infra/self-hosted/install.sh >/dev/null 2>&1
  bash /src/infra/self-hosted/install.sh >/dev/null 2>&1
  grep -qx 'KEEP=me' /root/sdp/.env \
    && grep -qx 'SENTINEL=keep' /root/sdp/.env.example \
    && [ -f /root/sdp/compose.yml ]
"; then check "does not clobber an existing .env or .env.example" 0
else check "does not clobber an existing .env or .env.example" 1; fi

echo "----"; echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
