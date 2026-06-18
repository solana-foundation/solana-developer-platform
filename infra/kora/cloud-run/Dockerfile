# Bake env config onto the prebuilt Kora image (published from main by kora's docker-edge.yml).
# :edge tracks the latest main; pin KORA_IMAGE to a :<sha> or release tag for mainnet once validated.
ARG KORA_IMAGE=ghcr.io/solana-foundation/kora:edge
FROM ${KORA_IMAGE}

# Non-secret config baked from the repo; secrets/env are injected at deploy from Doppler.
ARG KORA_CONFIG=kora.mainnet.toml
ARG SIGNERS_CONFIG=signers.mainnet.toml
COPY ${KORA_CONFIG} /app/config/kora.toml
COPY ${SIGNERS_CONFIG} /app/signers/signers.toml

CMD ["kora", "--config", "/app/config/kora.toml", "rpc", "start", \
     "--signers-config", "/app/signers/signers.toml", "--port", "8080"]
