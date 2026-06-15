ARG BASE=ghcr.io/solana-foundation/kora:latest
FROM ${BASE}

# Non-secret config baked from the repo. Secrets/env are injected at deploy time from Doppler.
ARG KORA_CONFIG=kora.mainnet.toml
ARG SIGNERS_CONFIG=signers.mainnet.toml
COPY ${KORA_CONFIG} /app/config/kora.toml
COPY ${SIGNERS_CONFIG} /app/signers/signers.toml

CMD ["kora", "--config", "/app/config/kora.toml", "rpc", "start", \
     "--signers-config", "/app/signers/signers.toml", "--port", "8080"]
