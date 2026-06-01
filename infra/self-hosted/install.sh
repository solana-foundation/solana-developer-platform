#!/usr/bin/env bash
#
# Bootstrap a self-hosted Solana Developer Platform.
#
# Verify before running:
#   curl -fsSL "<url>/install.sh" -o install.sh \
#     && sha256sum -c install.sh.sha256 \
#     && bash install.sh
#
# Overridable: SDP_INSTALL_DIR, INSTALL_VERSION, SDP_INSTALL_BASE_URL,
#              SDP_IMAGE_REGISTRY, SDP_CONFIGURATOR_URL.
set -euo pipefail

# Bumped by the release process to the tag that publishes the image + compose.yml.
DEFAULT_VERSION="v0.24.0"

VERSION="${INSTALL_VERSION:-$DEFAULT_VERSION}"
BASE_URL="${SDP_INSTALL_BASE_URL:-https://raw.githubusercontent.com/solana-foundation/solana-developer-platform}"
INSTALL_DIR="${SDP_INSTALL_DIR:-$HOME/sdp}"
IMAGE_REGISTRY="${SDP_IMAGE_REGISTRY:-ghcr.io/solana-foundation/sdp}"
CONFIGURATOR_URL="${SDP_CONFIGURATOR_URL:-https://sdp.solana.org/docs/self-hosting/configurator}"

err() { printf '%s\n' "$*" >&2; }

require_docker() {
  if ! command -v docker >/dev/null 2>&1; then
    err "Docker is not installed. Install it first: https://docs.docker.com/engine/install/"
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    err "Docker Compose v2 is unavailable. Update Docker: https://docs.docker.com/compose/install/"
    exit 1
  fi
  if ! docker info >/dev/null 2>&1; then
    err "The Docker daemon is not running or not reachable. Start Docker and retry."
    exit 1
  fi
}

# fetch <relative-path-under-infra/self-hosted> <destination>
fetch() {
  curl -fsSL "$BASE_URL/$VERSION/infra/self-hosted/$1" -o "$2"
}

# Echo a command that opens a URL in a browser, or nothing on a headless host.
detect_opener() {
  if command -v open >/dev/null 2>&1; then echo open; return; fi
  if command -v wslview >/dev/null 2>&1; then echo wslview; return; fi
  if [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1; then
    echo xdg-open; return
  fi
  echo ""
}

cli_command() {
  printf '    docker run --rm -it -v "%s:/out" %s/sdp-api:%s node configure.js --out /out/.env\n' \
    "$INSTALL_DIR" "$IMAGE_REGISTRY" "$VERSION"
}

main() {
  require_docker

  mkdir -p "$INSTALL_DIR"
  fetch compose.yml "$INSTALL_DIR/compose.yml"
  [ -f "$INSTALL_DIR/.env.example" ] || fetch .env.example "$INSTALL_DIR/.env.example"

  printf '\nInstalled compose.yml to %s\n' "$INSTALL_DIR"
  printf '\nNext: generate your .env\n'

  local opener; opener="$(detect_opener)"
  if [ -n "$opener" ]; then
    printf '  Opening the configurator in your browser: %s\n' "$CONFIGURATOR_URL"
    "$opener" "$CONFIGURATOR_URL" >/dev/null 2>&1 \
      || printf '  (could not open automatically — visit %s)\n' "$CONFIGURATOR_URL"
    printf '  Or run it in a terminal:\n'
    cli_command
  else
    printf '  Run the configurator in your terminal:\n'
    cli_command
    printf '  Or open the web form: %s\n' "$CONFIGURATOR_URL"
  fi

  printf '\nThen start the stack:\n  cd %s && docker compose up -d\n' "$INSTALL_DIR"
}

main "$@"
