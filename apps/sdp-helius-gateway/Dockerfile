# sdp-helius-gateway — Rust runtime image. Unlike the Node images in this repo,
# the build context is this directory, not the monorepo root: the crate is not a
# pnpm workspace member and has nothing to copy from outside itself.
#
#     docker build -f apps/sdp-helius-gateway/Dockerfile -t sdp-helius-gateway \
#       apps/sdp-helius-gateway
#
# amd64 only. Cloud Run is amd64, and cross-building the Groth16 and Poseidon
# dependencies under QEMU is slow enough to be impractical in any build that has to
# finish on a timer. Apple Silicon developers either emulate or run the gateway
# remotely.
#
# Digest-pinned to match the convention in apps/sdp-api/Dockerfile.

# --- chef: cargo-chef, so the dependency graph caches independently of our source
FROM rust:1.97.0-slim-bookworm@sha256:6d220bf85c74e842a79da63997af8d2e74455c0b8847d8bb3a5888572334991d AS chef
WORKDIR /build
# git: the zolana crates are unpublished and resolved from a git revision.
#
# pkg-config/libssl-dev: `openssl-sys` is in the graph, and not for TLS — reqwest
# here uses rustls. The path is
# openssl-sys <- openssl <- solana-secp256r1-program <- zolana-user-registry-interface,
# so it is the P256 curve support that needs it. That also means the runtime image
# needs libssl3; see the runner stage.
RUN apt-get update \
  && apt-get install --no-install-recommends -y git pkg-config libssl-dev ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
  cargo install cargo-chef --version 0.1.77 --locked

# --- planner: reduce the manifest to a dependency-only recipe
FROM chef AS planner
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src
COPY build.rs ./
RUN cargo chef prepare --recipe-path recipe.json

# --- builder: build dependencies first, then the crate
FROM chef AS builder
COPY --from=planner /build/recipe.json recipe.json
# This layer is the expensive one (~450 crates including solana-rpc-client,
# groth16 and poseidon) and it only invalidates when Cargo.lock changes.
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
  cargo chef cook --release --recipe-path recipe.json
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY src ./src
COPY build.rs ./
RUN --mount=type=cache,id=cargo-registry,target=/usr/local/cargo/registry \
  cargo build --release --locked --bin sdp-helius-gateway \
  && strip target/release/sdp-helius-gateway

# --- runner: no toolchain, no source, no cargo registry
FROM debian:bookworm-slim@sha256:abd67ffcfa541b485a3dff59865ab629aa048a6c613e639d36e7456b0b229241 AS runner
# libssl3: the binary dynamically links libssl.so.3 and libcrypto.so.3, because
# `solana-secp256r1-program` reaches OpenSSL for P256. Without it the loader fails
# before the listener ever binds, so this is a start-up dependency and not an
# optional hardening step. `libssl3` is bookworm's runtime package for OpenSSL 3.x;
# `libssl-dev` from the builder stage is deliberately not carried over.
RUN apt-get update \
  && apt-get install --no-install-recommends -y ca-certificates libssl3 \
  && rm -rf /var/lib/apt/lists/*

# UID/GID 1001 matches sdp-api and sdp-web so a shared k8s securityContext works.
RUN groupadd --gid 1001 sdp && useradd --uid 1001 --gid 1001 --no-create-home sdp

COPY --from=builder /build/target/release/sdp-helius-gateway /usr/local/bin/sdp-helius-gateway

USER 1001:1001
ENV HELIUS_GATEWAY_PORT=8788
EXPOSE 8788

# Liveness only, matching apps/sdp-api/Dockerfile: a status below 500 means the
# HTTP layer is up. Dependency probing belongs on a readiness probe, and /health
# does not reach the indexer, prover or RPC.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD ["/usr/local/bin/sdp-helius-gateway", "--health-check"]

ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision="${GIT_SHA}"
LABEL org.opencontainers.image.title="sdp-helius-gateway"
LABEL org.opencontainers.image.source="https://github.com/solana-foundation/solana-developer-platform"

CMD ["/usr/local/bin/sdp-helius-gateway"]
