#!/usr/bin/env bash
# End-to-end test for install.sh. Runs the script in clean ubuntu:24.04 containers
# with a stubbed `docker` and the release artifacts served from a local directory
# (standing in for the GitHub release surface, including SHA256SUMS).
# Requires a working local Docker. Usage: bash infra/self-hosted/install.test.sh
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
IMG="ubuntu:24.04"
pass=0
fail=0
check() { # check <name> <condition-rc>
  if [ "$2" -eq 0 ]; then echo "  PASS: $1"; pass=$((pass + 1)); else echo "  FAIL: $1"; fail=$((fail + 1)); fi
}

# Container preamble: install curl, build a writable /release dir with the flat
# assets + a matching SHA256SUMS, then run the scenario body ($1). INSTALL_VERSION="."
# collapses "$RELEASE_BASE_URL/./asset" to "/release/asset".
scenario() { # scenario <name> <docker-run-flags...> -- <in-container-bash>
  local name="$1"; shift
  local flags=(); while [ "$1" != "--" ]; do flags+=("$1"); shift; done; shift
  echo "[$name]"
  docker run --rm -v "$REPO:/src:ro" \
    -e SDP_RELEASE_BASE_URL="file:///release" -e INSTALL_VERSION="." \
    -e SDP_INSTALL_DIR="/root/sdp" \
    "${flags[@]}" "$IMG" bash -c "
      set -eu
      apt-get update -qq >/dev/null 2>&1
      apt-get install -y -qq curl >/dev/null 2>&1
      mkdir -p /release
      cp /src/infra/self-hosted/compose.yml /src/infra/self-hosted/.env.example \
         /src/infra/self-hosted/install.sh /release/
      ( cd /release && sha256sum install.sh compose.yml .env.example > SHA256SUMS )
      set +e
      $1
    "
}

# A fake docker that satisfies every preflight check. Single-quoted so \$1/\$2 reach
# the stub file literally.
# shellcheck disable=SC2016
DOCKER_OK='mkdir -p /usr/local/bin; cat > /usr/local/bin/docker <<"EOF"
#!/bin/sh
[ "$1 $2" = "compose version" ] && { echo "Docker Compose version v2.29.0"; exit 0; }
exit 0
EOF
chmod +x /usr/local/bin/docker'

# A fake docker whose daemon is down: `docker info` fails, everything else passes.
# shellcheck disable=SC2016
DOCKER_NO_DAEMON='mkdir -p /usr/local/bin; cat > /usr/local/bin/docker <<"EOF"
#!/bin/sh
[ "$1 $2" = "compose version" ] && { echo "Docker Compose version v2.29.0"; exit 0; }
[ "$1" = "info" ] && exit 1
exit 0
EOF
chmod +x /usr/local/bin/docker'

# 1. Docker missing -> clear error + non-zero exit, no files written.
# shellcheck disable=SC2016
if scenario "docker-missing" -- '
  out=$(bash /src/infra/self-hosted/install.sh 2>&1); rc=$?
  [ $rc -ne 0 ] && echo "$out" | grep -qi "docker is not installed" && [ ! -f /root/sdp/compose.yml ]
'; then check "exits non-zero with install-Docker message, writes nothing" 0
else check "exits non-zero with install-Docker message, writes nothing" 1; fi

# 2. Docker daemon down -> clear error + non-zero exit, no files written.
if scenario "daemon-down" -- "
  $DOCKER_NO_DAEMON
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -ne 0 ] && echo \"\$out\" | grep -qi 'daemon is not running' && [ ! -f /root/sdp/compose.yml ]
"; then check "exits non-zero when the Docker daemon is down, writes nothing" 0
else check "exits non-zero when the Docker daemon is down, writes nothing" 1; fi

# 3. Headless happy path -> verified compose.yml placed, CLI command printed, no open attempt.
if scenario "headless" -- "
  $DOCKER_OK
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -eq 0 ] \
    && cmp -s /root/sdp/compose.yml /src/infra/self-hosted/compose.yml \
    && [ -f /root/sdp/.env.example ] \
    && [ -f /root/sdp/SHA256SUMS ] \
    && echo \"\$out\" | grep -q 'node configure.js --out /out/.env' \
    && echo \"\$out\" | grep -qi 'cosign not found' \
    && ! echo \"\$out\" | grep -qi 'opening the configurator'
"; then check "places + verifies compose.yml, prints CLI handoff" 0
else check "places + verifies compose.yml, prints CLI handoff" 1; fi

# 4. Tampered compose.yml -> checksum mismatch aborts before any handoff.
if scenario "tampered" -- "
  $DOCKER_OK
  echo 'tampered: true' >> /release/compose.yml
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -ne 0 ] \
    && echo \"\$out\" | grep -qi 'checksum verification failed' \
    && ! echo \"\$out\" | grep -q 'node configure.js'
"; then check "aborts on a compose.yml checksum mismatch before handoff" 0
else check "aborts on a compose.yml checksum mismatch before handoff" 1; fi

# 5. cosign present but signature invalid -> abort before fetching artifacts.
if scenario "signature-invalid" -- "
  $DOCKER_OK
  printf '#!/bin/sh\nexit 1\n' > /usr/local/bin/cosign; chmod +x /usr/local/bin/cosign
  : > /release/SHA256SUMS.cosign.bundle
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -ne 0 ] \
    && echo \"\$out\" | grep -qi 'signature verification failed' \
    && [ ! -f /root/sdp/compose.yml ]
"; then check "aborts when the SHA256SUMS signature is invalid" 0
else check "aborts when the SHA256SUMS signature is invalid" 1; fi

# 6. cosign present and signature valid -> proceeds, passing the identity + issuer.
if scenario "signature-valid" -- "
  $DOCKER_OK
  printf '#!/bin/sh\necho \"\$@\" > /tmp/cosign-args\nexit 0\n' > /usr/local/bin/cosign; chmod +x /usr/local/bin/cosign
  : > /release/SHA256SUMS.cosign.bundle
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -eq 0 ] \
    && echo \"\$out\" | grep -q 'node configure.js --out /out/.env' \
    && grep -qF 'token.actions.githubusercontent.com' /tmp/cosign-args \
    && grep -qF 'release-checksums' /tmp/cosign-args
"; then check "proceeds when the SHA256SUMS signature is valid" 0
else check "proceeds when the SHA256SUMS signature is valid" 1; fi

# 7. Desktop -> auto-open invoked with the configurator URL (stub records its arg).
if scenario "desktop" -e DISPLAY=:0 -- "
  $DOCKER_OK
  printf '#!/bin/sh\necho \"\$1\" > /tmp/opened\n' > /usr/local/bin/xdg-open; chmod +x /usr/local/bin/xdg-open
  bash /src/infra/self-hosted/install.sh >/dev/null 2>&1
  grep -q 'self-hosting/configurator' /tmp/opened
"; then check "auto-opens the configurator URL on a GUI host" 0
else check "auto-opens the configurator URL on a GUI host" 1; fi

# 8. Idempotency -> an existing .env.example is preserved (and not re-verified) across runs.
if scenario "idempotent" -- "
  $DOCKER_OK
  mkdir -p /root/sdp
  printf 'SENTINEL=keep\n' > /root/sdp/.env.example
  bash /src/infra/self-hosted/install.sh >/dev/null 2>&1
  bash /src/infra/self-hosted/install.sh >/dev/null 2>&1
  grep -qx 'SENTINEL=keep' /root/sdp/.env.example && [ -f /root/sdp/compose.yml ]
"; then check "does not clobber an existing .env.example" 0
else check "does not clobber an existing .env.example" 1; fi

# 9. Failed upgrade -> a previously-working compose.yml survives a corrupt re-download.
if scenario "preserve-on-failed-upgrade" -- "
  $DOCKER_OK
  mkdir -p /root/sdp
  printf 'sentinel: keep-me\n' > /root/sdp/compose.yml
  echo 'tampered: true' >> /release/compose.yml
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -ne 0 ] \
    && echo \"\$out\" | grep -qi 'checksum verification failed' \
    && grep -qx 'sentinel: keep-me' /root/sdp/compose.yml
"; then check "preserves the existing compose.yml when the new download fails verification" 0
else check "preserves the existing compose.yml when the new download fails verification" 1; fi

# 10. A .env.example that fails verification leaves no file behind, so a re-run retries
#     instead of treating the corrupt download as a kept existing file.
if scenario "no-corrupt-env-example" -- "
  $DOCKER_OK
  echo 'TAMPERED=true' >> /release/.env.example
  out=\$(bash /src/infra/self-hosted/install.sh 2>&1); rc=\$?
  [ \$rc -ne 0 ] \
    && echo \"\$out\" | grep -qi 'checksum verification failed' \
    && [ ! -f /root/sdp/.env.example ]
"; then check "leaves no .env.example behind when its download fails verification" 0
else check "leaves no .env.example behind when its download fails verification" 1; fi

echo "----"; echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
