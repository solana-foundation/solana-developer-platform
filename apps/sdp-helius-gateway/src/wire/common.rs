//! Types shared across more than one endpoint.

use serde::{Deserialize, Serialize};

use crate::redact::SecretBytes;

/// A Solana address or public key, base58-encoded.
///
/// A plain `String` rather than a validating newtype: parsing belongs in the
/// handler that needs the parsed value.
pub type Base58Address = String;

/// Opaque bytes, standard base64. Used for 32-byte digests, borsh-serialized
/// instruction data, and serialized wire transactions.
pub type Base64Bytes = String;

/// A `u64` rendered as a decimal string.
///
/// Never a JSON number: lamport and SPL token amounts exceed 2^53−1, above which
/// a double-based JSON parser silently loses precision.
pub type U64String = String;

/// Rings key material for exactly one operation.
///
/// `rings-key-auth` is the custodian of record and the only service that can
/// decrypt these; `sdp-api` never holds them. They arrive injected by the key
/// authority for the length of one request and are dropped when it ends — no
/// endpoint anywhere returns key material to its caller.
///
/// It is sufficient to decrypt notes and compute nullifiers, and **not**
/// sufficient to transfer or withdraw value: the circuit commits which addresses
/// must sign the outer transaction, and that Ed25519 signature never leaves
/// `@sdp/custody`. [`ActionSpec::Merge`] is the exception — it proves ownership
/// in-circuit and needs only the fee payer's signature, so it can reshape a
/// wallet's notes without moving value out of it.
///
/// The shielded identity is **not** carried here. It is derived from the owner's
/// public Ed25519 address plus the public halves of the two keys below, so
/// shipping it would add a secret to the wire that could also disagree with the
/// keys it is supposed to describe.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KeyMaterial {
    /// Every current and historical viewing key, needed to scan the full history,
    /// each labelled with the generation number the key authority assigned it.
    ///
    /// Labelled rather than bare, because the index is now data that crosses three
    /// services — see [`IndexedViewingKey::index`].
    pub viewing_keys: Vec<IndexedViewingKey>,
    /// The **31-byte** nullifier secret. Required to derive nullifiers during
    /// witness assembly.
    ///
    /// Upstream calls this the *spend* nullifier key (`spend_nullifier_key`),
    /// naming its role in the circuit rather than any spending capability.
    ///
    /// 31, not 32 — it is a BN254 field element and must stay below the field
    /// modulus. The asymmetry with the 32-byte viewing keys above comes from
    /// upstream and is an easy source of silent bugs.
    pub nullifier_key: SecretBytes,
}

impl std::fmt::Debug for KeyMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Hand-written so a derive can never be reintroduced by accident. Counts
        // only; every component is a secret.
        f.debug_struct("KeyMaterial")
            .field(
                "viewing_keys",
                &format_args!("[redacted; {}]", self.viewing_keys.len()),
            )
            .field("nullifier_key", &"[redacted]")
            .finish()
    }
}

/// One viewing key with the generation number the key authority assigned it.
///
/// Under the old single-custodian model, "which key is index 2" was a convention
/// living in one service. It now spans three: `rings-key-auth` composes the array
/// and grows it on rotation, this gateway writes indices into the projection it
/// returns, and `sdp-api` stores that projection and passes it back on the next
/// sync. If the key authority ever returns the keys in a different order than it
/// did when a projection was written, every stored counter points at the wrong key
/// — and **the failure mode is not an error.** The wallet silently under-reports
/// its balance, producing wrong input selection or a spurious insufficient-funds
/// error on a funded wallet, and no component can detect it locally.
///
/// Carrying the index as data is what removes that class of bug.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IndexedViewingKey {
    /// Stable, append-only, never reused: a rotation issues index N+1.
    ///
    /// This is what [`ViewingKeyCounter::viewing_key_index`] refers to, so it must
    /// mean the same key for the life of the wallet. Indices are validated as
    /// strictly ascending and unique at the request boundary, which is what lets
    /// array position and index agree at runtime.
    pub index: u32,
    /// A **32-byte** P256 secret scalar.
    pub key: SecretBytes,
}

impl std::fmt::Debug for IndexedViewingKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Hand-written for the same reason as `KeyMaterial`: the index is safe to
        // print, the key never is.
        f.debug_struct("IndexedViewingKey")
            .field("index", &self.index)
            .field("key", &"[redacted]")
            .finish()
    }
}

/// Wallet state SDP persists on behalf of the gateway.
///
/// The gateway holds nothing between requests, but a from-scratch rescan is
/// incorrect past a bounded horizon. The SDK's sync walks at
/// most `rounds × tag_window` (6 × 64 = 384) tag positions and resets its
/// cursors on every call, and view tags are counter-derived. A wallet whose
/// counters have advanced beyond that horizon would silently under-report its
/// balance, producing wrong input selection or a spurious insufficient-funds
/// error on a funded wallet.
///
/// So [`sync`](crate::wire::sync) returns this projection, SDP stores it
/// encrypted, and passes it back. It is the gateway's own type because nothing
/// in the SDK's pipeline is serde-serializable: `zolana-transaction` does not
/// depend on `serde`, and `Wallet` derives nothing at all — not even `Clone`.
///
/// `version` is present so a projection written by an older gateway is detected
/// rather than misread. On mismatch the gateway must ignore the projection and
/// full-rescan, reporting it through [`SyncReport`].
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalletProjection {
    /// Schema version of this projection.
    pub version: u32,
    /// Per-viewing-key transaction counters that drive view-tag derivation.
    pub tag_counters: Vec<ViewingKeyCounter>,
    /// Known notes, spent and unspent.
    pub utxos: Vec<ProjectedUtxo>,
}

/// A viewing key's observed transaction count, which determines its next view
/// tag.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewingKeyCounter {
    /// The [`IndexedViewingKey::index`] this counter belongs to — a generation
    /// number, not a position in an array.
    pub viewing_key_index: u32,
    /// Transactions observed for this viewing key.
    pub tx_count: U64String,
}

/// One note in the wallet's inventory.
#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProjectedUtxo {
    /// Commitment hash identifying the note. This is what SDP pins.
    pub utxo_hash: Base64Bytes,
    /// Mint address, or the SOL sentinel mint.
    pub asset: Base58Address,
    /// Note value in the asset's base units.
    pub amount: U64String,
    /// The note's blinding factor. Secret: it is an input to the nullifier, so
    /// SDP must store the projection encrypted.
    pub blinding: Base64Bytes,
    /// Whether the note has been observed spent.
    pub spent: bool,
}

/// What a sync could not account for.
///
/// Mirrors the SDK's own report. Non-zero counters mean the balance in the same
/// response may be incomplete, so SDP must surface and alert on these rather
/// than treat a `200` as a clean read.
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    /// Notes stored by this sync.
    pub stored_utxos: u64,
    /// Transactions the client could not parse.
    pub unparsed_transactions: u64,
    /// Ciphertexts that matched a tag but failed to decrypt.
    pub undecryptable_candidates: u64,
    /// Assets seen on notes that are not in the asset registry.
    pub unknown_asset_ids: Vec<Base58Address>,
    /// True when the supplied [`WalletProjection`] was rejected and a full
    /// rescan was performed, which may have hit the tag-window horizon.
    pub full_rescan: bool,
}

/// Fields every POST carries.
///
/// A named nested object rather than `#[serde(flatten)]`, because `flatten` and
/// `deny_unknown_fields` do not compose in serde — flattening would silently
/// disable the drift check on every request type.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preamble {
    /// Correlation identifier for joining gateway logs to an SDP operation
    /// attempt. **Not** an idempotency key — see the module documentation.
    pub request_id: String,
    /// The custody wallet's public Ed25519 address.
    ///
    /// Public, and required on every call: combined with the public halves of
    /// [`KeyMaterial`], it reconstructs the shielded identity. It is also the
    /// address that must sign the outer transaction to authorize a spend.
    pub owner: Base58Address,
    /// Per-operation key material.
    pub key_material: KeyMaterial,
    /// Wallet state from a previous sync, when SDP has one.
    pub wallet_projection: Option<WalletProjection>,
    /// Slot the indexer must have reached before its answers are accepted.
    ///
    /// SDP reads this from the RPC endpoint it submits through, so both sides of
    /// the comparison are slots from the same source. Without it, two
    /// consecutive balance reads can go backwards across indexer replicas —
    /// which is indistinguishable from lost funds to a user.
    pub require_slot: Option<u64>,
}

/// The operation to build.
///
/// Every variant spends notes and needs a Groth16 proof, which is what makes
/// [`plan`](crate::wire::plan) → [`prove`](crate::wire::prove) →
/// [`assemble`](crate::wire::assemble) the right shape for all of them. Shield is
/// absent because a deposit spends nothing, so it has a single-call endpoint of
/// its own at [`shield`](crate::wire::shield) rather than three round trips whose
/// plan and prove responses would be empty by construction.
///
/// Default ring only: instruction tags 12 (`TRANSACT`) and 13 (`MERGE_TRANSACT`).
/// Policy-ring variants (tags 14–17) are out of scope — every policy-ring
/// instruction requires the ring config account to sign, which only a deployed
/// ring program can produce via `invoke_signed`, and zone creation is permissioned
/// on devnet with an unfunded authority.
///
/// Field names follow the SDK's own parameter structs so the mapping into them is
/// mechanical.
#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum ActionSpec {
    /// Private transfer to a registered recipient. Tag 12.
    Transfer {
        /// Recipient's public Solana address; its shielded address is resolved
        /// from the on-chain user registry.
        recipient: Base58Address,
        /// Mint to send.
        asset: Base58Address,
        /// Amount in base units.
        amount: U64String,
    },
    /// Public withdrawal out of the pool. Tag 12.
    Withdraw {
        /// One or more payout legs.
        legs: Vec<WithdrawalLeg>,
    },
    /// Consolidate up to 8 same-asset notes into 1. Tag 13.
    ///
    /// Merge proves ownership in-circuit from the nullifier key, so it needs no
    /// custody signature — only the fee payer's. It is also the only SDK action
    /// that already accepts an explicit input set.
    Merge {
        /// Mint to consolidate.
        asset: Base58Address,
        /// Explicit note commitment hashes, or `None` to sweep the smallest
        /// notes of the asset.
        inputs: Option<Vec<Base64Bytes>>,
    },
    /// Split one note into `parts` equal self-owned notes. Tag 12.
    ///
    /// The input amount must divide evenly into `parts`.
    Split {
        /// Mint to split.
        asset: Base58Address,
        /// Number of output notes.
        parts: u8,
        /// Explicit note commitment hash, or `None` to pick the largest unspent
        /// note of the asset.
        input: Option<Base64Bytes>,
    },
}

/// One payout in a withdrawal.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WithdrawalLeg {
    /// Public recipient address.
    pub recipient: Base58Address,
    /// Mint to pay out.
    pub asset: Base58Address,
    /// Amount in base units.
    pub amount: U64String,
    /// SPL Token or Token-2022 program for non-SOL assets.
    pub spl_token_program: Option<Base58Address>,
}
