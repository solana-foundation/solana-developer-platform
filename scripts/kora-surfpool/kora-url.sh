# Sourced by up.sh, run.sh, test.sh and integration.sh. Points the API at the
# harness Kora for the cluster SOLANA_NETWORK names (the API's own default is
# devnet) and clears the other cluster's Kora, so a Doppler-mounted deployed
# Kora never serves a harness run; that cluster answers wallet-pays. The
# audience is cleared too: the harness Kora is plain HTTP on loopback.
KORA_SURFPOOL_KORA_URL="${KORA_SURFPOOL_KORA_RPC_URL:-http://127.0.0.1:18080}"

case "${SOLANA_NETWORK:-devnet}" in
  mainnet-beta)
    KORA_SURFPOOL_ENV_PREFIX="KORA_MAINNET"
    unset KORA_DEVNET_URL KORA_DEVNET_API_KEY KORA_DEVNET_CLOUD_RUN_AUDIENCE KORA_MAINNET_CLOUD_RUN_AUDIENCE
    ;;
  devnet)
    KORA_SURFPOOL_ENV_PREFIX="KORA_DEVNET"
    unset KORA_MAINNET_URL KORA_MAINNET_API_KEY KORA_MAINNET_CLOUD_RUN_AUDIENCE KORA_DEVNET_CLOUD_RUN_AUDIENCE
    ;;
  *)
    echo "Unsupported SOLANA_NETWORK for the Kora harness: ${SOLANA_NETWORK}" >&2
    exit 1
    ;;
esac

export "${KORA_SURFPOOL_ENV_PREFIX}_URL=${KORA_SURFPOOL_KORA_URL}"
