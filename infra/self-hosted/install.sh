#!/usr/bin/env bash
#
# Bootstrap a self-hosted Solana Developer Platform.
#
# This script is open source — read it before piping it to a shell.
# It installs the latest release by default; set INSTALL_VERSION to pin a tag.
# To verify the install script and config against the release checksums:
#   V=v0.24.0   # the release tag you want
#   R=https://github.com/solana-foundation/solana-developer-platform/releases/download
#   curl -fsSL "$R/$V/install.sh" -o install.sh
#   curl -fsSL "$R/$V/SHA256SUMS" -o SHA256SUMS
#   sha256sum --ignore-missing -c SHA256SUMS && INSTALL_VERSION="$V" bash install.sh
#
# For out-of-band authenticity, verify the keyless cosign signature of SHA256SUMS:
#   curl -fsSL "$R/$V/SHA256SUMS.cosign.bundle" -o SHA256SUMS.cosign.bundle
#   cosign verify-blob --bundle SHA256SUMS.cosign.bundle \
#     --certificate-identity-regexp '^https://github\.com/solana-foundation/solana-developer-platform/\.github/workflows/release-checksums\.yml@refs/tags/v[0-9][^/]*$' \
#     --certificate-oidc-issuer https://token.actions.githubusercontent.com SHA256SUMS
#
# Overridable: SDP_INSTALL_DIR, INSTALL_VERSION, SDP_RELEASE_BASE_URL,
#              SDP_IMAGE_REGISTRY, SDP_CONFIGURATOR_URL.
set -euo pipefail

# Fallback used only when the latest release tag cannot be resolved.
DEFAULT_VERSION="v0.24.0"

RELEASE_BASE_URL="${SDP_RELEASE_BASE_URL:-https://github.com/solana-foundation/solana-developer-platform/releases/download}"
INSTALL_DIR="${SDP_INSTALL_DIR:-$HOME/sdp}"
IMAGE_REGISTRY="${SDP_IMAGE_REGISTRY:-ghcr.io/solana-foundation/sdp}"
CONFIGURATOR_URL="${SDP_CONFIGURATOR_URL:-https://sdp.solana.org/docs/self-hosting/configurator}"
VERSION=""

err() { printf '%s\n' "$*" >&2; }

# Pinned tag from INSTALL_VERSION, otherwise the tag the "latest" release
# redirects to, otherwise DEFAULT_VERSION.
resolve_version() {
  if [ -n "${INSTALL_VERSION:-}" ]; then
    printf '%s' "$INSTALL_VERSION"
    return
  fi
  local url
  url="$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "https://github.com/solana-foundation/solana-developer-platform/releases/latest" 2>/dev/null || true)"
  case "$url" in
    */releases/tag/*) printf '%s' "${url##*/}" ;;
    *)
      err "Warning: could not resolve the latest release; using $DEFAULT_VERSION."
      printf '%s' "$DEFAULT_VERSION"
      ;;
  esac
}

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

# fetch <release-asset-name> <destination>
fetch() {
  curl -fsSL "$RELEASE_BASE_URL/$VERSION/$1" -o "$2"
}

# sha256sum is Linux-native; macOS ships shasum instead.
_sha256sum() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$@"
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$@"
  else
    err "Neither sha256sum nor shasum is available. Install coreutils and retry."
    exit 1
  fi
}

# verify_signature: when cosign is available, verify the keyless signature of
# SHA256SUMS and fail closed on a bad signature. Skip (with a notice) when cosign
# or the bundle is unavailable — checksum verification of the artifacts still applies.
verify_signature() {
  if ! command -v cosign >/dev/null 2>&1; then
    printf '\nNote: cosign not found; skipping signature check (checksums still verified).\n' >&2
    return
  fi
  if ! fetch SHA256SUMS.cosign.bundle "$INSTALL_DIR/SHA256SUMS.cosign.bundle" 2>/dev/null; then
    printf '\nNote: no signature bundle for %s; skipping signature check.\n' "$VERSION" >&2
    return
  fi
  local output
  if ! output="$(cosign verify-blob \
      --bundle "$INSTALL_DIR/SHA256SUMS.cosign.bundle" \
      --certificate-identity-regexp '^https://github\.com/solana-foundation/solana-developer-platform/\.github/workflows/release-checksums\.yml@refs/tags/v[0-9][^/]*$' \
      --certificate-oidc-issuer https://token.actions.githubusercontent.com \
      "$INSTALL_DIR/SHA256SUMS" 2>&1)"; then
    err "Signature verification failed for SHA256SUMS. Refusing to continue."
    err "$output"
    exit 1
  fi
}

# verify <asset-name> [file-path]: check file-path (default $INSTALL_DIR/<asset-name>)
# against the checksum recorded for <asset-name> in the downloaded SHA256SUMS. The
# split lets us verify a download under a temp path before swapping it into place.
# Fail closed.
verify() {
  local file="${2:-$INSTALL_DIR/$1}" want have
  want="$(awk -v f="$1" '$2 == f { print $1; exit }' "$INSTALL_DIR/SHA256SUMS")"
  if [ -z "$want" ]; then
    err "No checksum recorded for $1 in SHA256SUMS. Refusing to continue."
    exit 1
  fi
  have="$(_sha256sum "$file" | awk '{print $1}')"
  if [ "$have" != "$want" ]; then
    err "Checksum verification failed for $1. Refusing to continue."
    exit 1
  fi
}

# fetch_verified <asset-name> <dest>: download to a temp path, verify its checksum,
# and swap it into <dest> only after verification passes. A corrupt or interrupted
# download therefore never overwrites an existing good file nor leaves a partial one
# behind; the temp is cleaned up on any exit.
fetch_verified() {
  local tmp="$2.tmp.$$"
  trap '[ -z "${tmp:-}" ] || rm -f "$tmp"' EXIT
  fetch "$1" "$tmp"
  verify "$1" "$tmp"
  mv -f "$tmp" "$2"
  trap - EXIT
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
  VERSION="$(resolve_version)"

  mkdir -p "$INSTALL_DIR"
  fetch SHA256SUMS "$INSTALL_DIR/SHA256SUMS"
  verify_signature
  local had_compose=0
  if [ -f "$INSTALL_DIR/compose.yml" ]; then had_compose=1; fi
  fetch_verified compose.yml "$INSTALL_DIR/compose.yml"
  if [ "$had_compose" -eq 1 ]; then
    printf '\nReplaced the existing compose.yml with the %s release.\n' "$VERSION"
  fi
  if [ ! -f "$INSTALL_DIR/.env.example" ]; then
    fetch_verified default.env.example "$INSTALL_DIR/.env.example"
  else
    printf '\nKept your existing .env.example. Review the %s template for new variables:\n  %s/%s/default.env.example\n' \
      "$VERSION" "$RELEASE_BASE_URL" "$VERSION"
  fi

  printf '\nInstalled and verified compose.yml in %s\n' "$INSTALL_DIR"
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
