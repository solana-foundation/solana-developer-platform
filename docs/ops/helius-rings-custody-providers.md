# Helius Rings custody providers: who works, why, and what's next

## How SDP and Helius Rings interact

A Rings private wallet is backed by an SDP custody wallet. SDP stores no shielded key
material at rest. Every time it needs the wallet's keys (a balance read, a shield, a
withdraw), it asks the custody provider to sign a fixed derivation message from the
Helius SDK and expands the keys from the 64 signature bytes:

    custody wallet signs the derivation message → 64-byte signature
        → viewing + nullifier keys → shielded address

The signature is used as a password, not an authorization. The scheme works only if the
provider returns the exact same bytes every time it signs that message.

**Sign the envelope, not the payload.** The bytes are Zolana's 99-byte Solana
off-chain-message v0 envelope, which wraps the `TSPP/derive/v1` payload and binds it to
the owner address — not the bare string a browser wallet would sign. The two produce
different seeds and therefore different shielded identities, with no way back. Get the
exact bytes from `derivationMessageBase64(owner)`
(`packages/sdp-helius-rings-sdk/src/custody-ka/seed.ts`); anything probing a provider or
persisting a seed has to sign those and nothing else.

## The problem

Whether a signature is reproducible depends on how the provider holds the key.

- **Privy and Turnkey** hold the whole key in an enclave and sign per RFC 8032: the
  nonce is a hash of the key and the message, so the same message always yields the
  same signature. Verified live against both APIs (2026-09-11).
- **Fireblocks, Para and DFNS** are MPC custodians. The key never exists in one place,
  so no party can compute the deterministic nonce, and MPC protocols must randomize it:
  reusing nonces across signing ceremonies enables key recovery (RFC 9591 requires
  random nonces; Fireblocks documents the same). Same message, different signature,
  every time.

On an MPC provider a Rings wallet derives a different identity on every signing call.
It works right after provisioning, then the first re-derivation (a service restart, or
the next balance read) produces keys that don't match the published ones, and the
wallet pauses. Re-keying publishes yet another one-off identity, so it only helps
until the next derivation.

## What we do about it now

`RAW_MESSAGE_SIGNING_PROVIDERS` (apps/sdp-api/src/services/helius-rings/signer-adapter.ts)
lists only the providers whose signing is reproducible: `local`, `privy`, `turnkey`.
Everyone else is refused at provisioning with an error naming the provider.
(`coinbase_cdp`, `utila` and `anchorage` were already excluded for a cruder reason:
they cannot sign the raw derivation bytes at all.)

## Known limitation: custom ring administration

The gate sits on custody signer resolution, which every Rings signature goes through —
including the ones that bring up and adopt a custom ring (the auditor-key attestation,
the registration transactions, the adoption challenge). Those need a valid signature,
not a reproducible one, so the requirement is stricter there than it has to be: a ring
whose authority custody wallet lives on an unsupported provider cannot be brought up,
even when every private wallet in the project is on a supported one.

Not fixed, because the configuration it blocks (an MPC-held ring authority beside
supported private wallets) does not exist yet, and the shape of the fix should follow a
real need. When one appears, the split is between the capability (signs raw messages)
and the requirement (signs them reproducibly): ring administration would check the
first, and only shielded-key derivation the second.

## Options for MPC providers later

Neither is built. Either would let Fireblocks/Para/DFNS wallets hold a stable identity.

1. **Persist the seed.** Sign the derivation message once at provisioning and store the
   64-byte signature encrypted in SDP's database; later operations reuse it instead of
   re-asking the signer. Reproducibility stops depending on the provider. The cost: the
   seed is the shielded keys, so SDP would hold spend-capable key material at rest —
   exactly what the current design avoids.
2. **SDP-generated keys.** Generate the viewing and nullifier keys in SDP, store them
   encrypted, and register them on-chain directly, skipping Helius's signature-derived
   (TVC-style) key scheme for these providers. The same at-rest custody question as
   option 1, plus two key models to maintain, but no dependency on signing behavior.
