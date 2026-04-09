#!/usr/bin/env bash
set -euo pipefail

if command -v doppler >/dev/null 2>&1; then
  doppler --version
  exit 0
fi

curl -Ls --tlsv1.2 --proto '=https' --retry 3 https://cli.doppler.com/install.sh | sudo sh
doppler --version
