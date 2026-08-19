# sdp-rings-key-auth

Internal Rust custody boundary for Helius Rings viewing and nullifier keys.

This package is intentionally a contract-only skeleton. It defines the API,
authorization boundary, encrypted-storage seams, secret-safe in-memory types, and
sidecar wire compatibility. It generates protocol-valid initial key material in
memory, but does not yet persist, encrypt, decrypt, or forward live key material.

## Security boundary

- SDP supplies an opaque stage capability and an immutable request envelope.
- The authority recomputes an RFC 8785 canonical request hash before asking the
  `StageAuthorizer` to verify the capability.
- The production default authorizer rejects every key-bearing request. A
  permissive fallback does not exist.
- Viewing secrets are exactly 32 bytes; the nullifier secret is exactly 31 bytes.
  Their domain types are non-serializable, redact `Debug`, and zeroize on drop.
- Serialization is confined to the sidecar gateway module. Encoded secret
  strings are zeroized, and production adapters must serialize directly into
  `SecretBody` rather than an ordinary `String`, `Vec`, or JSON value.
- `KeyStore`, `EnvelopeCipher`, and `GatewayClient` are ports only. No production
  adapter is included in this skeleton.
- No endpoint returns Rings secret material.

## HTTP contract

`GET /health` is implemented. It reports liveness separately from adapter
readiness; `ready` remains false until every production adapter is installed.

The following internal routes authenticate, deserialize, validate, recompute the
immutable stage hash, and invoke `StageAuthorizer`. With a test authorizer they
then return a stable `501 NOT_IMPLEMENTED` response:

- `POST /v1/wallets`
- `POST /v1/wallets/{walletId}/rotate`
- `POST /v1/wallets/sync`
- `POST /v1/operations/plan`
- `POST /v1/operations/prove`

Stage capabilities use `Authorization: Bearer <opaque-token>`. The token format
is deliberately unresolved. Error responses use the stable error envelope and
echo only a sanitized `x-request-id`.

The canonical hash fixture in
[`tests/fixtures/stage-hash-plan.json`](tests/fixtures/stage-hash-plan.json) is
the cross-language contract SDP must reproduce before issuing stage tokens.
Inputs outside the I-JSON safe integer range are rejected.

## Sidecar compatibility

The outbound wire types match the key-bearing request shape introduced in sidecar
PR 1289:

- viewing keys are append-only indexed generations;
- viewing secrets are standard-base64 encoded 32-byte values;
- the nullifier secret is a standard-base64 encoded 31-byte value;
- the HMAC signer matches PR 1290 exactly: lowercase-hex HMAC-SHA256 over
  `decimal_timestamp + raw_body`.

Compatibility is pinned by the sync, plan, and prove fixtures in
[`tests/fixtures`](tests/fixtures).

## Key generation

`ZolanaKeyGenerator` creates an independent initial key set from the operating
system RNG:

- generation-zero P-256 viewing key;
- independent 31-byte nullifier secret;
- compressed 33-byte viewing public key;
- Poseidon-derived 32-byte nullifier public key.

Generation uses the same pinned `zolana-keypair` revision as the sidecar contract.
Tests reconstruct both SDK keys from the generated secret containers and verify
that their public halves match. A fixed vector also pins the standard P-256
scalar-one public key and Zolana's published nullifier public key. Generation
remains internal: `/v1/wallets` stays at `501` until persistence and envelope
encryption can store the secrets atomically.

## Deferred implementation

- Dedicated Postgres schema, repositories, and stage-release ledger
- AES-GCM envelope encryption and GCP KMS integration
- Viewing-key rotation
- Cloud Run identity-token verification and a concrete stage-token format
- Live sidecar HTTP forwarding
- Customer-hosted authentication, recovery, backup, and key export

## Development

```bash
cargo fmt --check
cargo clippy --all-targets --all-features --locked -- -D warnings
cargo test --locked
cargo audit
```

Run locally with `cargo run`; the default port is `8789`.
`sdp-rings-key-auth --health-check` probes the running service.
