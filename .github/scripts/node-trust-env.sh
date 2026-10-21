# BASH_ENV for CI shell steps. Runs before pnpm installs and Node scripts;
# GitHub does not permit writing NODE_OPTIONS through GITHUB_ENV.
export NODE_OPTIONS="--require=${GITHUB_WORKSPACE}/packages/sdp-env-config/src/tls-trust.cjs${NODE_OPTIONS:+ $NODE_OPTIONS}"
