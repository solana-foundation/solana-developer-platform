# Builds Kora from main — gcp_kms signer + KORA_REDIS_URL env are not in any release yet.
# Switch to FROM ghcr.io/solana-foundation/kora:<tag> once a release includes them.
FROM rustlang/rust:nightly AS build
ARG KORA_REF=main
RUN cargo install --git https://github.com/solana-foundation/kora --branch ${KORA_REF} kora-cli

# trixie (glibc 2.41) matches the nightly builder's glibc; bookworm (2.36) is too old.
FROM debian:trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/cargo/bin/kora /usr/local/bin/kora

# Non-secret config baked from the repo; secrets/env are injected at deploy from Doppler.
ARG KORA_CONFIG=kora.mainnet.toml
ARG SIGNERS_CONFIG=signers.mainnet.toml
COPY ${KORA_CONFIG} /app/config/kora.toml
COPY ${SIGNERS_CONFIG} /app/signers/signers.toml

CMD ["kora", "--config", "/app/config/kora.toml", "rpc", "start", \
     "--signers-config", "/app/signers/signers.toml", "--port", "8080"]
