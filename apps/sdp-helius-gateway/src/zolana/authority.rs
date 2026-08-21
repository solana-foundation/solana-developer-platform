//! The gateway's [`WalletAuthority`] implementation.
//!
//! The whole trait is satisfiable with **no Ed25519 signing key**, which is the
//! security model.
//!
//! # Why there is no signing key
//!
//! `ShieldedAddress` has public fields, and the only Ed25519 component it needs is
//! a *public* key (`PublicKey::from_ed25519`). `sign_p256` signs with the viewing
//! key, which is a P256 secret we already hold. So this authority can decrypt
//! notes, derive nullifiers and produce the P256 signatures the protocol wants —
//! and it still cannot move funds, because a spend also requires an Ed25519
//! signature on the outer transaction, which only `@sdp/custody` can produce.
//!
//! So a sidecar does not need spend authority: spend authorization is not
//! in-circuit. The circuit commits *which* addresses must sign; the Solana runtime
//! enforces that they did.
//!
//! # The merge gap, and how [`MergeKeypair`] closes it
//!
//! `create_merge` takes a concrete `&ShieldedKeypair`, whose `signing_key` field
//! only constructs from a *secret* (`from_bytes`, `from_ed25519`, `new`). This
//! service holds no such secret, so that entry point is unreachable from here even
//! though merge's own documentation says it proves ownership in-circuit from the
//! nullifier secret and therefore needs no owner signature.
//!
//! The layer underneath it is reachable. `Merge::new` and its
//! `validate_merge_inputs` are generic over `ShieldedKeypairTrait`, and every
//! method that path actually calls — signing *pubkey*, curve, address derivation,
//! nullifier derivation — is satisfiable from public material plus the nullifier
//! secret. [`MergeKeypair`] is that adapter, and this module's tests drive
//! `Merge::new` through it in a process holding no Ed25519 signing key at all.
//!
//! One method resists. `ShieldedKeypairTrait::sign` returns `[u8; 64]` with no
//! error channel, so an implementation without a signing key cannot decline — only
//! panic. Merge never calls it, verified against `Merge::new` and
//! `validate_merge_inputs` at the pinned rev, which means the panic is unreachable
//! **by inspection of upstream's call graph rather than by the type system**. That
//! is the residual risk this module accepts, and the reason the first ask below is
//! worth making.
//!
//! Two upstream asks follow, both about merge:
//!
//! - **Move `sign` off `ShieldedKeypairTrait`** into a signing-only trait, or make
//!   it return `Result`. Then a proof-only custodian satisfies the trait honestly
//!   and the panic below stops existing.
//! - **Provide a custodian submission path.** `submit_merge_transaction` takes a
//!   raw fee-payer `Keypair` and submits directly, which a remote signer such as
//!   Kora cannot satisfy. Upstream already did the harder half here: it takes a
//!   `MergeMaterial { signing_pubkey, viewing_pubkey, nullifier_key }` rather than
//!   a keypair, explicitly "leaving every signing/viewing/funding secret behind" —
//!   which is exactly this service's shape. Only the fee payer and the
//!   submit-versus-return-bytes shape remain.

// The authority is exercised by this module's tests; the flow handlers that
// construct it in production are not implemented yet.
#![allow(dead_code)]

use std::sync::Mutex;

use async_trait::async_trait;
use solana_address::Address;
use zolana_keypair::{
    KeypairError, NullifierKey, P256Pubkey, PublicKey, ShieldedKeypairTrait, SignatureType,
    ViewingKey, hash,
    shielded::{CompressedShieldedAddress, ShieldedAddress},
    viewing_key::ViewTag,
};
use zolana_transaction::{
    AssetRegistry, SppProofOutputUtxo, TransactionError,
    serialization::{anonymous::AnonymousTransferSenderPlaintext, split::SplitBundlePlaintext},
};
use zolana_wallet::{
    AnonymousRecipientSlot, ApprovalRequest, EncryptedSplit, EncryptedTransfer, P256Signature,
    WalletAuthority,
};

// The widths live with the boundary that enforces them, so there is one definition
// of "a nullifier secret is 31 bytes" rather than two that can drift.
use crate::validate::{NULLIFIER_SECRET_LEN, VIEWING_KEY_LEN};

/// A [`WalletAuthority`] over key material supplied with a single request.
///
/// Holds no durable state and is dropped when the request ends. The secrets are
/// zeroized by [`crate::redact::SecretBytes`] on the way out.
pub struct RequestAuthority {
    owner: Address,
    /// Index-labelled, ascending. The label is the key authority's generation number
    /// and is what the wallet projection's counters refer to — not a position in this
    /// vector.
    ///
    /// The labels are retained because the projection this authority's caller emits
    /// has to carry the generation number. They are stripped before the SDK sees the
    /// keys: upstream has no notion of them and must not gain one.
    viewing_keys: Vec<(u32, ViewingKey)>,
    nullifier_key: NullifierKey,
    /// Captured approval summary.
    ///
    /// `request_user_approval` has a default no-op implementation upstream and is
    /// invoked during witness assembly, *before* the prover runs. Implementing it
    /// as a capture hook gives us the SDK's own description of the operation for
    /// SDP's approval UI, with no callback from this service into SDP — so
    /// approvals stay an in-process concern on SDP's side.
    ///
    /// A `Mutex` because the trait method takes `&self`.
    approval_summary: Mutex<Option<String>>,
}

impl RequestAuthority {
    /// Rebuilds an authority from request material.
    ///
    /// `owner` is public; the two key arguments are secret scalars.
    ///
    /// The widths are asymmetric, and an easy source of silent bugs: a viewing key
    /// is a **32-byte** P256 scalar, while a nullifier secret is **31 bytes**. It
    /// is a BN254 field element, so it is held below the field modulus rather than
    /// filling 32 bytes. Both are checked at the request boundary by
    /// [`crate::validate`], which also guarantees the indices below are strictly
    /// ascending — this constructor relies on that rather than re-sorting.
    pub fn new(
        owner: Address,
        viewing_keys: &[(u32, [u8; VIEWING_KEY_LEN])],
        nullifier_key_bytes: [u8; NULLIFIER_SECRET_LEN],
    ) -> Result<Self, TransactionError> {
        let viewing_keys = viewing_keys
            .iter()
            .map(|(index, bytes)| ViewingKey::from_bytes(bytes).map(|key| (*index, key)))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(Self {
            owner,
            viewing_keys,
            nullifier_key: NullifierKey::from_secret(nullifier_key_bytes),
            approval_summary: Mutex::new(None),
        })
    }

    /// The viewing key carrying a given generation number, if this authority holds it.
    ///
    /// Resolves by label rather than by position, which is the whole point of
    /// carrying the label: a wallet projection's counters name generations, and those
    /// need not be contiguous once a rotation has happened.
    pub fn viewing_key_at(&self, index: u32) -> Option<&ViewingKey> {
        self.viewing_keys
            .iter()
            .find(|(candidate, _)| *candidate == index)
            .map(|(_, key)| key)
    }

    /// The summary captured during witness assembly, if any.
    pub fn captured_summary(&self) -> Option<String> {
        self.approval_summary.lock().ok()?.clone()
    }

    /// The highest-indexed viewing key, which is the one outbound payloads encrypt
    /// under.
    ///
    /// `max_by_key` rather than `.last()`: with the indices validated as strictly
    /// ascending the two agree, but the newest key is defined by its generation
    /// number rather than by where it happens to sit, and saying so here means a
    /// future change to the ordering guarantee cannot silently pick the wrong key.
    fn current_viewing_key(&self) -> Result<&ViewingKey, TransactionError> {
        self.viewing_keys
            .iter()
            .max_by_key(|(index, _)| *index)
            .map(|(_, key)| key)
            .ok_or(TransactionError::MissingRingProgramId)
    }

    /// Borrows this authority as the keypair-shaped view `Merge::new` requires.
    ///
    /// Fallible only because it resolves the current viewing key up front, which is
    /// what lets every infallible method on [`MergeKeypair`] not fail.
    pub fn merge_keypair(&self) -> Result<MergeKeypair<'_>, TransactionError> {
        Ok(MergeKeypair {
            owner: self.owner,
            viewing_key: self.current_viewing_key()?,
            nullifier_key: &self.nullifier_key,
        })
    }
}

/// The slice of a shielded keypair a merge actually uses, borrowed from a
/// [`RequestAuthority`].
///
/// Merge is the one operation whose entitlement proof needs no owner signature, so
/// it is the one operation a key-holding-but-not-signing service should be able to
/// build end to end. `Merge::new` is generic over `ShieldedKeypairTrait`, so it
/// can be — this type is the adapter that states it in the type system. See the
/// module documentation for why the high-level `create_merge` cannot be used.
///
/// # Why this is a separate type rather than another impl on `RequestAuthority`
///
/// Two reasons.
///
/// `ShieldedKeypairTrait::sign` is infallible, so this implementation must panic
/// (see the method). Confining it to a type that exists only to be handed to
/// `Merge::new` keeps that panic reachable from one call path, instead of hanging
/// off the authority every handler passes around freely.
///
/// Second, `WalletAuthority::shielded_address` is async and yields a
/// [`TransactionError`] while `ShieldedKeypairTrait::shielded_address` is
/// synchronous and yields a [`KeypairError`]. Implementing both traits on one type
/// would make every unqualified `shielded_address()` call ambiguous at the call
/// site.
pub struct MergeKeypair<'a> {
    owner: Address,
    viewing_key: &'a ViewingKey,
    nullifier_key: &'a NullifierKey,
}

impl ShieldedKeypairTrait for MergeKeypair<'_> {
    fn signing_pubkey(&self) -> PublicKey {
        // A *public* key: merge binds the owner identity without ever needing the
        // secret behind it.
        PublicKey::from_ed25519(self.owner.as_array())
    }

    fn viewing_pubkey(&self) -> P256Pubkey {
        self.viewing_key.pubkey()
    }

    fn curve(&self) -> Result<SignatureType, KeypairError> {
        // Mirrors upstream's own impl: the transfer rail follows the signing
        // pubkey's scheme. SDP custody wallets are Ed25519, so this is the Solana
        // rail, and `validate_merge_inputs` checks every input agrees.
        self.signing_pubkey().signature_type()
    }

    fn shielded_address(&self) -> Result<ShieldedAddress, KeypairError> {
        Ok(ShieldedAddress {
            signing_pubkey: self.signing_pubkey(),
            nullifier_pubkey: self.nullifier_key.pubkey()?,
            viewing_pubkey: self.viewing_pubkey(),
        })
    }

    fn owner_hash(&self) -> Result<[u8; 32], KeypairError> {
        hash::owner_hash(&self.signing_pubkey(), &self.nullifier_key.pubkey()?)
    }

    fn compressed_address(&self) -> Result<CompressedShieldedAddress, KeypairError> {
        Ok(CompressedShieldedAddress {
            owner_hash: self.owner_hash()?,
            viewing_pubkey: self.viewing_pubkey(),
        })
    }

    fn sign(&self, _msg: &[u8]) -> [u8; 64] {
        // The one method this service cannot honour, and the trait gives it no
        // error channel — so declining is not expressible and panicking is the only
        // honest option. Returning zeroed bytes would be worse: it would forge a
        // signature-shaped value and defer the failure to the circuit or the
        // runtime, surfacing as an opaque proof or transaction rejection instead of
        // a stack trace pointing here.
        //
        // Unreachable on the merge path at the pinned rev: `Merge::new` and
        // `validate_merge_inputs` call only the identity and nullifier methods
        // above. That is a property of upstream's call graph, not of these types,
        // so it is re-checked when the rev is bumped.
        unreachable!(
            "merge must not sign: this authority holds viewing and nullifier \
             secrets only. Reaching this means the zolana revision began signing \
             on the merge path, and the gateway's security model needs \
             re-examining before that rev ships."
        )
    }

    fn nullifier(
        &self,
        utxo_hash: &[u8; 32],
        blinding: &[u8; 32],
    ) -> Result<[u8; 32], KeypairError> {
        self.nullifier_key.nullifier(utxo_hash, blinding)
    }

    fn nullifier_key(&self) -> NullifierKey {
        self.nullifier_key.clone()
    }
}

#[async_trait]
impl WalletAuthority for RequestAuthority {
    fn solana_pubkey(&self) -> Address {
        self.owner
    }

    async fn shielded_address(&self) -> Result<ShieldedAddress, TransactionError> {
        // Derived, never transported. Every component here is a public value:
        // the owner's Ed25519 address, and the public halves of the two keys.
        let viewing_key = self.current_viewing_key()?;
        Ok(ShieldedAddress {
            signing_pubkey: PublicKey::from_ed25519(self.owner.as_array()),
            nullifier_pubkey: self.nullifier_key.pubkey()?,
            viewing_pubkey: viewing_key.pubkey(),
        })
    }

    async fn viewing_keys(&self) -> Result<Vec<ViewingKey>, TransactionError> {
        // Labels stripped: the SDK has no notion of our generation numbers and must
        // not gain one. It scans with whatever keys it is given.
        Ok(self
            .viewing_keys
            .iter()
            .map(|(_, key)| key.clone())
            .collect())
    }

    async fn encrypt_confidential_transfer(
        &self,
        _first_nullifier: &[u8; 32],
        _outputs: &[SppProofOutputUtxo],
        _assets: &AssetRegistry,
    ) -> Result<EncryptedTransfer, TransactionError> {
        todo!("encrypt the transfer output payloads under the recipient's viewing key")
    }

    async fn encrypt_anonymous_transfer(
        &self,
        _first_nullifier: &[u8; 32],
        _sender_view_tag: ViewTag,
        _sender: &AnonymousTransferSenderPlaintext,
        _recipients: &[AnonymousRecipientSlot],
    ) -> Result<EncryptedTransfer, TransactionError> {
        // `unimplemented!` rather than `todo!`, because this is not pending work.
        // No builder upstream calls it in either language, and it is unresolved
        // whether anonymous payloads are usable on the default ring at all, since
        // default-ring outputs are tagged by owner pubkey.
        unimplemented!("out of scope: anonymous transfers are unresolved upstream")
    }

    async fn encrypt_split(
        &self,
        _first_nullifier: &[u8; 32],
        _view_tag: ViewTag,
        _bundle: &SplitBundlePlaintext,
    ) -> Result<EncryptedSplit, TransactionError> {
        todo!("encrypt the split bundle under this wallet's own viewing key")
    }

    async fn request_user_approval(
        &self,
        request: ApprovalRequest,
    ) -> Result<(), TransactionError> {
        // Capture, never block. SDP owns approval: it has already gated this
        // operation through its policy engine before calling us, and blocking
        // here would invert that relationship across a network boundary.
        if let Ok(mut slot) = self.approval_summary.lock() {
            *slot = Some(request.summary);
        }
        Ok(())
    }

    async fn sign_p256(&self, _message_hash: &[u8; 32]) -> Result<P256Signature, TransactionError> {
        // `unimplemented!` rather than `todo!`, because this is not pending work.
        //
        // At rev c53d7998 the only real invocation in the tree is inside
        // `key_binding_proof` (`sdk-libs/wallet/src/user_registry.rs`), which returns
        // `Ok(None)` before reaching it when the signing pubkey is Ed25519 — and every
        // SDP custody wallet is Ed25519. Every other occurrence is a trait
        // declaration, a blanket impl, a test double, or the CLI. The key-authority
        // design agrees from its own side: it exposes a sign-p256 route and marks it
        // unused by the shipping flows.
        //
        // Note what this is *not* saying: it **is** satisfiable from the viewing key
        // this authority already holds, since that is a P256 secret. So if a future
        // rev starts calling it, the fix is to implement it here — not to route it to
        // the key authority, which would move a secret for no reason.
        //
        // Re-checked on every rev bump, on the same footing as `MergeKeypair::sign`.
        unimplemented!("out of scope at the pinned rev: no shipping flow signs with P256")
    }

    async fn spend_nullifier_key(&self) -> Result<NullifierKey, TransactionError> {
        Ok(self.nullifier_key.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use zolana_transaction::instructions::merge::{MERGE_INPUTS, Merge};
    use zolana_transaction::instructions::types::SppProofInputUtxo;
    use zolana_transaction::{Blinding, Data, Utxo};

    fn authority() -> RequestAuthority {
        // Fixed non-zero bytes: a valid P256 scalar, not a real key.
        RequestAuthority::new(
            Address::new_from_array([7u8; 32]),
            &[(0, [3u8; VIEWING_KEY_LEN])],
            [5u8; NULLIFIER_SECRET_LEN],
        )
        .expect("authority should build from raw key material")
    }

    /// An authority holding three generations with a gap, which is what a wallet
    /// looks like after rotations that skipped indices.
    fn rotated_authority() -> RequestAuthority {
        RequestAuthority::new(
            Address::new_from_array([7u8; 32]),
            &[
                (0, [3u8; VIEWING_KEY_LEN]),
                (3, [4u8; VIEWING_KEY_LEN]),
                (7, [6u8; VIEWING_KEY_LEN]),
            ],
            [5u8; NULLIFIER_SECRET_LEN],
        )
        .expect("authority should build from raw key material")
    }

    #[tokio::test]
    async fn derives_a_shielded_address_without_any_signing_key() {
        // This succeeds while the process holds no Ed25519 secret at all.
        let authority = authority();
        let address = authority.shielded_address().await.expect("derivable");

        assert_eq!(
            address.signing_pubkey.as_ed25519().expect("ed25519 tagged"),
            [7u8; 32],
            "shielded identity must bind to the custody address"
        );
        assert_eq!(authority.solana_pubkey().as_array(), &[7u8; 32]);
    }

    #[tokio::test]
    async fn exposes_the_nullifier_key_for_witness_assembly() {
        let authority = authority();
        let key = authority.spend_nullifier_key().await.expect("held");
        assert_eq!(key.secret(), &[5u8; NULLIFIER_SECRET_LEN]);
    }

    #[tokio::test]
    async fn captures_the_approval_summary_instead_of_calling_back() {
        let authority = authority();
        assert!(authority.captured_summary().is_none());

        authority
            .request_user_approval(ApprovalRequest {
                solana_pubkey: Address::new_from_array([7u8; 32]),
                summary: "Send 1.5 SOL privately".to_owned(),
            })
            .await
            .expect("capture never fails");

        assert_eq!(
            authority.captured_summary().as_deref(),
            Some("Send 1.5 SOL privately")
        );
    }

    /// A blinding that is a valid BN254 field element: byte zero cleared so the
    /// big-endian value stays below the modulus, the same shape `random_blinding`
    /// produces. Fixed rather than random so a failure reproduces.
    fn blinding(seed: u8) -> Blinding {
        let mut bytes = [seed; 32];
        bytes[0] = 0;
        bytes
    }

    /// A plain note owned by `keypair`: no ring binding, no attached data, which is
    /// what merge requires of every input.
    fn note(
        keypair: &MergeKeypair<'_>,
        asset: Address,
        amount: u64,
        seed: u8,
    ) -> SppProofInputUtxo {
        SppProofInputUtxo::new(
            Utxo {
                owner: keypair.signing_pubkey(),
                asset,
                amount,
                blinding: blinding(seed),
                ring_program_id: None,
                data: Data::default(),
            },
            keypair.nullifier_key(),
        )
    }

    #[test]
    fn builds_a_merge_with_no_signing_key_in_the_process() {
        // `Merge::new` runs upstream's own validation (owner rail, owner match,
        // nullifier-key match, asset match, plain-utxo check) against material that
        // contains no Ed25519 secret.
        let authority = authority();
        let keypair = authority.merge_keypair().expect("a viewing key is present");
        let asset = Address::new_from_array([9u8; 32]);

        let prepared = Merge::new(
            &keypair,
            vec![
                note(&keypair, asset, 400, 11),
                note(&keypair, asset, 600, 22),
            ],
        )
        .expect("merge builds from viewing and nullifier material alone")
        .prepare();

        assert_eq!(prepared.output.amount, 1_000, "inputs sum into one output");
        assert_eq!(
            prepared.inputs.len(),
            MERGE_INPUTS,
            "prepare pads to the circuit's fixed arity"
        );
        assert_eq!(
            prepared.signing_pubkey,
            keypair.signing_pubkey(),
            "the output binds the owner identity, not a signature"
        );
    }

    #[tokio::test]
    async fn derives_the_same_identity_through_both_traits() {
        // Two traits derive the shielded identity by different code paths. Drift
        // would mean a merge spending notes the rest of the gateway does not agree
        // are ours, so it is worth pinning.
        let authority = authority();
        let via_wallet_authority = authority.shielded_address().await.expect("derivable");
        let via_merge_keypair = authority
            .merge_keypair()
            .expect("a viewing key is present")
            .shielded_address()
            .expect("derivable");

        assert_eq!(via_wallet_authority, via_merge_keypair);
    }

    #[tokio::test]
    async fn public_halves_derive_the_same_shielded_address_as_the_secrets() {
        // The property that makes a keyless `/v1/wallets/register` safe: the shielded
        // identity built from the public halves SDP sends is byte-identical to the one
        // this authority derives from the corresponding secrets. If it were not, a
        // registration would bind a wallet to an identity its own key material does
        // not describe.
        let authority = authority();
        let from_secrets = authority.shielded_address().await.expect("derivable");

        // Exactly what the register handler will do, holding no secret at all.
        let from_public_halves = ShieldedAddress {
            signing_pubkey: PublicKey::from_ed25519(&[7u8; 32]),
            nullifier_pubkey: from_secrets.nullifier_pubkey,
            viewing_pubkey: from_secrets.viewing_pubkey,
        };

        assert_eq!(from_secrets, from_public_halves);
    }

    #[test]
    fn resolves_viewing_keys_by_generation_not_position() {
        // Counters in a stored projection name generations. After a rotation those
        // need not be contiguous, and resolving by position would silently return the
        // wrong key — which under-reports a balance rather than erroring.
        let authority = rotated_authority();

        assert!(authority.viewing_key_at(0).is_some());
        assert!(authority.viewing_key_at(3).is_some());
        assert!(authority.viewing_key_at(7).is_some());
        assert!(
            authority.viewing_key_at(1).is_none(),
            "index 1 was never issued"
        );
        assert!(
            authority.viewing_key_at(2).is_none(),
            "position 2 holds generation 7, and must not answer to 2"
        );
    }

    #[test]
    fn the_current_viewing_key_is_the_highest_generation() {
        let authority = rotated_authority();
        let current = authority.current_viewing_key().expect("keys are present");

        assert_eq!(
            current.pubkey(),
            authority
                .viewing_key_at(7)
                .expect("generation 7 is held")
                .pubkey(),
            "outbound payloads must encrypt under the newest key"
        );
    }

    #[tokio::test]
    async fn labels_are_stripped_before_the_sdk_sees_the_keys() {
        // Upstream has no notion of our generation numbers. What it receives is a
        // plain list, in ascending-generation order.
        let authority = rotated_authority();
        let handed_over = authority.viewing_keys().await.expect("keys are present");

        assert_eq!(handed_over.len(), 3);
        assert_eq!(
            handed_over[2].pubkey(),
            authority.viewing_key_at(7).expect("held").pubkey(),
            "the last key handed over is the newest generation"
        );
    }

    #[test]
    #[should_panic(expected = "merge must not sign")]
    fn signing_panics_because_this_authority_holds_no_signing_key() {
        // Documents the trait method we declare but cannot honour. It is unreachable
        // on the merge path today; this test asserts the failure mode is a loud
        // panic rather than a forged signature-shaped value, so a zolana rev that
        // starts signing during merge is caught here.
        let authority = authority();
        let keypair = authority.merge_keypair().expect("a viewing key is present");

        let _ = keypair.sign(b"a message merge should never produce");
    }
}
