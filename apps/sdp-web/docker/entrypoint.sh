#!/bin/sh
set -e

node /app/inject-public-env.mjs $SDP_INJECT_DIRS

exec "$@"
