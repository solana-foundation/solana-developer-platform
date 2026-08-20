//! `POST /v1/wallets/register` — bind a shielded identity to an SDP custody wallet.
//!
//! # Why this endpoint carries no secrets
//!
//! Registration is keyless, and that is a simplification rather than a compromise.
//! Under the key-authority topology no component that can call this endpoint holds
//! the secrets: `sdp-api` never has them, and registration routes straight to this
//! gateway without passing through `rings-key-auth`, so there is nothing in the path
//! to inject them either. A [`Preamble`](super::common::Preamble) here would be
//! unfillable.
//!
//! It is also unnecessary. Upstream's `build_registration_transaction` takes a
//! `&ShieldedAddress` — not a keypair and not a `WalletAuthority` — and every
//! component of a `ShieldedAddress` is public: the owner's Ed25519 signing pubkey,
//! the 32-byte nullifier pubkey, and the 33-byte compressed P256 viewing pubkey. The
//! shielded identity is derived from public halves, so the handler needs no
//! authority object at all.
//!
//! For Ed25519 owners — every SDP custody wallet — upstream's `proof` argument must
//! be `None`: `key_binding_proof` returns `Ok(None)` early on Ed25519, and supplying
//! one is rejected.
//!
//! # Why the public keys are base64
//!
//! They are not Solana addresses. A compressed P256 point and a BN254-adjacent field
//! element have no base58 convention, and
//! [`RegisterResponse::shielded_address`] — which is these three components
//! serialized — is already base64. See the encoding conventions in
//! [`super`].

use serde::{Deserialize, Serialize};

use super::common::{Base58Address, Base64Bytes};

/// Registration request.
///
/// Carries no key material; see the module documentation.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RegisterRequest {
    /// Correlation identifier for logs. Not an idempotency key — this service is
    /// stateless and cannot deduplicate.
    pub request_id: String,
    /// The custody wallet the shielded identity binds to. It must sign the
    /// resulting transaction.
    pub owner: Base58Address,
    /// Public half of the wallet's current viewing key: a 33-byte compressed P256
    /// point, from the key authority's wallet-creation response.
    pub viewing_pubkey: Base64Bytes,
    /// Public half of the nullifier key: 32 bytes. Never rotates, which is what
    /// makes it the stronger of the two bindings to a wallet.
    pub nullifier_pubkey: Base64Bytes,
    /// A blockhash fetched from the **same** RPC endpoint SDP will submit
    /// through, on the same rule as
    /// [`AssembleRequest::recent_blockhash`](super::assemble::AssembleRequest::recent_blockhash).
    ///
    /// An input rather than something the gateway reads, because the response is
    /// a complete transaction and its expiry clock starts here — before it
    /// travels back to SDP and through two remote signers. It is also why the
    /// handler must not use upstream's `build_registration_transaction`, which
    /// fetches a blockhash internally.
    pub recent_blockhash: Base58Address,
    /// Fee payer for the registration transaction. Resolved by SDP's sponsorship
    /// layer; the gateway never chooses one.
    pub fee_payer: Base58Address,
}

/// Registration response.
///
/// One endpoint covers three outcomes — first registration, no-op, and key update —
/// because upstream picks the instruction by comparing against the existing record.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegisterResponse {
    /// Unsigned wire transaction for SDP to sign and submit.
    ///
    /// `None` when the on-chain record already matches the supplied keys: there is
    /// nothing to sign and the wallet should be treated as registered. Registration
    /// is idempotent on chain and emits no transaction in that case, which every
    /// re-provision and every retry hits.
    ///
    /// `Some` covers both a first registration and a key update — a viewing-key
    /// rotation leaves the record present but different, and upstream responds with
    /// `update_keys` rather than nothing.
    ///
    /// Deliberately not paired with an `alreadyRegistered` boolean: one fact, one
    /// field. Two fields encoding one fact invites them to disagree.
    pub transaction: Option<Base64Bytes>,
    /// Addresses that must sign, in the order the transaction expects. Includes
    /// the fee payer.
    ///
    /// Empty when `transaction` is `None`.
    pub required_signers: Vec<Base58Address>,
    /// The shielded address derived from the supplied public keys, so SDP can
    /// persist it alongside the wallet row. Always present — it is a function of
    /// the request, not of what the chain already holds.
    pub shielded_address: Base64Bytes,
}
