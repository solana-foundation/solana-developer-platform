//! Structural checks that deserialization cannot express.
//!
//! # Why this exists as a separate pass
//!
//! [`SecretBytes`](crate::redact::SecretBytes) is an unvalidated `Vec<u8>`: it decodes
//! base64 and stops. A 32-byte nullifier key therefore deserializes cleanly and fails
//! much later, inside `NullifierKey::from_secret([u8; NULLIFIER_SECRET_LEN])`, as an
//! opaque conversion error in the middle of a handler.
//!
//! Under the old model both secrets were generated and consumed inside SDP. They are
//! now generated in a different service, across a language boundary, by code this
//! repository does not review. A width mistake is therefore a cross-service
//! integration bug, and it has to fail as a typed `400` at the edge, naming the field.
//!
//! # The widths are asymmetric
//!
//! That asymmetry is the whole reason this module has constants rather than literals.
//! A swapped pair — a 31-byte viewing key and a 32-byte nullifier secret — is the
//! realistic mistake, and it is invisible without a check.
//!
//! # What an error may say
//!
//! Field names and lengths only. [`SecretBytes::len`](crate::redact::SecretBytes::len)
//! is documented safe to log; `expose` must never appear in this module.
//!
//! # Totality
//!
//! Every request type implements [`Validate`], returning `Ok(())` where there is
//! nothing to check, and `ValidatedJson` requires the bound. A new request type
//! therefore cannot be added without deciding what its validation is.

use crate::error::GatewayError;
use crate::wire::assemble::AssembleRequest;
use crate::wire::common::KeyMaterial;
use crate::wire::merging::MergingRequest;
use crate::wire::nullifiers::NullifierStatusRequest;
use crate::wire::plan::PlanRequest;
use crate::wire::prove::ProveRequest;
use crate::wire::register::RegisterRequest;
use crate::wire::shield::ShieldRequest;
use crate::wire::sync::SyncRequest;

/// Width of a viewing key secret, in bytes. A P256 scalar.
pub const VIEWING_KEY_LEN: usize = 32;

/// Width of a nullifier secret, in bytes.
///
/// 31, not 32: it is a BN254 field element and must stay below the field modulus.
/// Viewing keys are 32 bytes, so the two are not interchangeable.
pub const NULLIFIER_SECRET_LEN: usize = 31;

/// Width of a compressed P256 public key, in bytes. The public half of a viewing key.
pub const P256_PUBKEY_LEN: usize = 33;

/// Width of a nullifier public key, in bytes.
pub const NULLIFIER_PUBKEY_LEN: usize = 32;

/// Structural validation applied after a successful deserialize.
pub trait Validate {
    /// Checks the request is internally coherent.
    ///
    /// Errors must name the field and lengths only — never a value.
    fn validate(&self) -> Result<(), GatewayError>;
}

/// Rejects a base64 field whose decoded width is wrong.
fn expect_len(field: &str, actual: usize, expected: usize) -> Result<(), GatewayError> {
    if actual == expected {
        return Ok(());
    }
    Err(GatewayError::InvalidRequest(format!(
        "{field} must be {expected} bytes, got {actual}"
    )))
}

impl Validate for KeyMaterial {
    fn validate(&self) -> Result<(), GatewayError> {
        if self.viewing_keys.is_empty() {
            return Err(GatewayError::InvalidRequest(
                "keyMaterial.viewingKeys must not be empty".to_owned(),
            ));
        }

        for entry in &self.viewing_keys {
            expect_len(
                "keyMaterial.viewingKeys[].key",
                entry.key.len(),
                VIEWING_KEY_LEN,
            )?;
        }

        // Strictly ascending and unique. Enforcing it here is what lets array
        // position and index agree at runtime, so the newest key is the last one.
        for pair in self.viewing_keys.windows(2) {
            if pair[1].index <= pair[0].index {
                return Err(GatewayError::InvalidRequest(
                    "keyMaterial.viewingKeys[].index must be strictly ascending and unique"
                        .to_owned(),
                ));
            }
        }

        expect_len(
            "keyMaterial.nullifierKey",
            self.nullifier_key.len(),
            NULLIFIER_SECRET_LEN,
        )
    }
}

impl Validate for RegisterRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        // The public halves, which is all this endpoint receives. Decoding happens
        // in `SecretBytes` for secrets; these are plain base64 strings, so their
        // width is checked once decoded by the handler. Until then the check that
        // matters is that they decode to the right length at all.
        expect_len(
            "viewingPubkey",
            decoded_len("viewingPubkey", &self.viewing_pubkey)?,
            P256_PUBKEY_LEN,
        )?;
        expect_len(
            "nullifierPubkey",
            decoded_len("nullifierPubkey", &self.nullifier_pubkey)?,
            NULLIFIER_PUBKEY_LEN,
        )
    }
}

impl Validate for SyncRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        self.preamble.key_material.validate()
    }
}

impl Validate for PlanRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        self.preamble.key_material.validate()
    }
}

impl Validate for ProveRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        self.preamble.key_material.validate()
    }
}

impl Validate for ShieldRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        // Keyless and structurally flat: every field is a public address or an
        // amount, and a bad address fails when the handler parses it.
        Ok(())
    }
}

impl Validate for AssembleRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        // Keyless and pure. The proved payload it carries is validated by the
        // assembly step itself, which is the only thing that can judge it.
        Ok(())
    }
}

impl Validate for MergingRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        // Keyless: an address and a boolean.
        Ok(())
    }
}

impl Validate for NullifierStatusRequest {
    fn validate(&self) -> Result<(), GatewayError> {
        if self.nullifiers.is_empty() {
            return Err(GatewayError::InvalidRequest(
                "nullifiers must not be empty".to_owned(),
            ));
        }
        Ok(())
    }
}

/// Decoded length of a base64 field, or a typed error naming the field.
///
/// The decoded bytes are dropped: this is a width check, and these fields are public
/// key halves rather than secrets, so the handler decodes them again when it needs
/// the value.
fn decoded_len(field: &str, encoded: &str) -> Result<usize, GatewayError> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(encoded.as_bytes())
        .map(|bytes| bytes.len())
        .map_err(|_| GatewayError::InvalidRequest(format!("{field} is not valid base64")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::redact::SecretBytes;
    use crate::wire::common::IndexedViewingKey;

    fn viewing(index: u32, len: usize) -> IndexedViewingKey {
        IndexedViewingKey {
            index,
            key: SecretBytes::from_bytes(vec![3u8; len]),
        }
    }

    fn material(viewing_keys: Vec<IndexedViewingKey>, nullifier_len: usize) -> KeyMaterial {
        KeyMaterial {
            viewing_keys,
            nullifier_key: SecretBytes::from_bytes(vec![5u8; nullifier_len]),
        }
    }

    #[test]
    fn accepts_correct_widths_and_ascending_indices() {
        let material = material(
            vec![
                viewing(0, VIEWING_KEY_LEN),
                viewing(3, VIEWING_KEY_LEN),
                viewing(7, VIEWING_KEY_LEN),
            ],
            NULLIFIER_SECRET_LEN,
        );
        assert!(material.validate().is_ok(), "non-contiguous is still valid");
    }

    #[test]
    fn rejects_the_swapped_pair() {
        // The realistic mistake: 31-byte viewing key, 32-byte nullifier secret.
        let swapped = material(vec![viewing(0, NULLIFIER_SECRET_LEN)], VIEWING_KEY_LEN);
        let error = swapped.validate().expect_err("must reject");
        let rendered = error.to_string();
        assert!(rendered.contains("viewingKeys"), "got {rendered}");
        assert!(rendered.contains("32"), "must name the expected width");
    }

    #[test]
    fn rejects_a_wrong_width_nullifier_key() {
        let wrong = material(vec![viewing(0, VIEWING_KEY_LEN)], VIEWING_KEY_LEN);
        let error = wrong.validate().expect_err("must reject");
        assert!(error.to_string().contains("nullifierKey"));
    }

    #[test]
    fn rejects_descending_or_duplicate_indices() {
        let descending = material(
            vec![viewing(5, VIEWING_KEY_LEN), viewing(2, VIEWING_KEY_LEN)],
            NULLIFIER_SECRET_LEN,
        );
        assert!(
            descending.validate().is_err(),
            "descending must be rejected"
        );

        let duplicate = material(
            vec![viewing(2, VIEWING_KEY_LEN), viewing(2, VIEWING_KEY_LEN)],
            NULLIFIER_SECRET_LEN,
        );
        assert!(duplicate.validate().is_err(), "duplicates must be rejected");
    }

    #[test]
    fn rejects_empty_viewing_keys() {
        let empty = material(vec![], NULLIFIER_SECRET_LEN);
        assert!(empty.validate().is_err());
    }

    #[test]
    fn an_error_never_carries_the_key_bytes() {
        // A length and a field name are safe; the value is not.
        let wrong = material(vec![viewing(0, 7)], NULLIFIER_SECRET_LEN);
        let rendered = wrong.validate().expect_err("must reject").to_string();
        assert!(!rendered.contains("AwMD"), "base64 of the key leaked");
        assert!(!rendered.contains("[3"), "raw bytes leaked");
    }
}
