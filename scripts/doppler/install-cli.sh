#!/usr/bin/env bash
set -euo pipefail

if command -v doppler >/dev/null 2>&1; then
  doppler --version
  exit 0
fi

# Keep the release version and hashes pinned together so CI never executes an
# unverified remote installer script.
DOPPLER_VERSION="3.75.3"
DOPPLER_INSTALL_DIR="${DOPPLER_INSTALL_DIR:-/usr/local/bin}"

case "$(uname -s)" in
  Linux)
    os="linux"
    ;;
  Darwin)
    os="macOS"
    ;;
  *)
    echo "Unsupported operating system for Doppler CLI installation: $(uname -s)" >&2
    exit 1
    ;;
esac

case "$(uname -m)" in
  x86_64 | amd64)
    arch="amd64"
    ;;
  arm64 | aarch64)
    arch="arm64"
    ;;
  *)
    echo "Unsupported architecture for Doppler CLI installation: $(uname -m)" >&2
    exit 1
    ;;
esac

asset="doppler_${DOPPLER_VERSION}_${os}_${arch}.tar.gz"

case "${asset}" in
  doppler_3.75.3_linux_amd64.tar.gz)
    expected_sha256="9c840cdd32cffff06d048329549ba2fa908146b385f21cd1d54bf34a0082d0db"
    ;;
  doppler_3.75.3_linux_arm64.tar.gz)
    expected_sha256="f1954f3717fe4c5b65e906a3c6dfe0d20e97b032af35e43db41250931302e143"
    ;;
  doppler_3.75.3_macOS_amd64.tar.gz)
    expected_sha256="94fbc9838b7acb48a80ae6e1db03a1b05c54b27984cf40a41fa312ce5d5ad066"
    ;;
  doppler_3.75.3_macOS_arm64.tar.gz)
    expected_sha256="1c56e625ea460b3af8b2ea88b89183af50b85f02c1fc9c06d0684586d12a54e4"
    ;;
  *)
    echo "No pinned checksum is available for Doppler asset ${asset}" >&2
    exit 1
    ;;
esac

tmpdir="$(mktemp -d)"
trap 'rm -rf "${tmpdir}"' EXIT

archive_path="${tmpdir}/${asset}"
download_url="https://github.com/DopplerHQ/cli/releases/download/${DOPPLER_VERSION}/${asset}"

curl -fsSL --tlsv1.2 --proto '=https' --retry 3 "${download_url}" -o "${archive_path}"

if command -v sha256sum >/dev/null 2>&1; then
  actual_sha256="$(sha256sum "${archive_path}" | awk '{print $1}')"
elif command -v shasum >/dev/null 2>&1; then
  actual_sha256="$(shasum -a 256 "${archive_path}" | awk '{print $1}')"
else
  echo "sha256sum or shasum is required to verify the Doppler CLI archive" >&2
  exit 1
fi

if [ "${actual_sha256}" != "${expected_sha256}" ]; then
  echo "Checksum verification failed for ${asset}" >&2
  echo "Expected: ${expected_sha256}" >&2
  echo "Actual:   ${actual_sha256}" >&2
  exit 1
fi

tar -xzf "${archive_path}" -C "${tmpdir}" doppler

if [ -d "${DOPPLER_INSTALL_DIR}" ]; then
  :
elif [ -w "$(dirname "${DOPPLER_INSTALL_DIR}")" ]; then
  mkdir -p "${DOPPLER_INSTALL_DIR}"
else
  sudo mkdir -p "${DOPPLER_INSTALL_DIR}"
fi

if [ -w "${DOPPLER_INSTALL_DIR}" ]; then
  install -m 0755 "${tmpdir}/doppler" "${DOPPLER_INSTALL_DIR}/doppler"
else
  sudo install -m 0755 "${tmpdir}/doppler" "${DOPPLER_INSTALL_DIR}/doppler"
fi

"${DOPPLER_INSTALL_DIR}/doppler" --version
