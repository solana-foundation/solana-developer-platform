//! Secret handling for request-borne key material.
//!
//! The gateway is stateless: `rings-key-auth` owns the Rings viewing and nullifier
//! keys, and injects them into the request body for the lifetime of one operation.
//! That makes accidental disclosure through a log line the most likely way this
//! service leaks, and a derived `Debug` the most likely cause.

use std::fmt;

use base64::Engine as _;
use serde::{Deserialize, Deserializer};
use zeroize::{Zeroize, ZeroizeOnDrop};

/// Raw secret bytes decoded from a base64 wire field.
///
/// Deserializes from a base64 string, zeroizes on drop, and has a hand-written
/// [`fmt::Debug`] so it cannot be printed by accident.
///
/// # What this does not protect
///
/// Zeroizing this value is defence in depth, not a guarantee. The same bytes
/// also transiently exist in:
///
/// - the raw request body buffer hyper read from the socket;
/// - serde's intermediate `String` (zeroized below, but only after `decode`
///   has already copied out of it);
/// - any `tracing` field or span that captures a containing struct.
///
/// The first two are outside our control. The third is not: no span or event
/// may take a [`KeyMaterial`](crate::wire::common::KeyMaterial) field. That is a
/// review rule, because no compiler check enforces it.
#[derive(Clone, ZeroizeOnDrop)]
pub struct SecretBytes(Vec<u8>);

impl SecretBytes {
    /// Wraps already-decoded bytes, for secrets that do not arrive over the wire
    /// (the configured HMAC key).
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    /// Borrows the secret bytes.
    ///
    /// Named `expose` rather than `as_slice` so that every call site is visible as
    /// a disclosure during review.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }

    /// Number of secret bytes held. Safe to log — a length is not a secret.
    pub fn len(&self) -> usize {
        self.0.len()
    }

    /// Whether the secret is empty. Present because clippy's
    /// `len_without_is_empty` requires it alongside [`Self::len`]; nothing calls it.
    #[allow(dead_code)]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for SecretBytes {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Length only. It is useful when diagnosing a malformed request and it
        // reveals nothing about the value.
        write!(f, "SecretBytes([redacted]; {} bytes)", self.len())
    }
}

impl<'de> Deserialize<'de> for SecretBytes {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let mut encoded = String::deserialize(deserializer)?;
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(encoded.as_bytes())
            .map_err(serde::de::Error::custom);
        // Clear the base64 form regardless of whether decoding succeeded: a
        // malformed-input error path is still a path that held the secret.
        encoded.zeroize();
        Ok(Self(decoded?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"nullifier-key-material-not-a-real-key";

    fn encoded() -> String {
        base64::engine::general_purpose::STANDARD.encode(SECRET)
    }

    #[test]
    fn debug_never_reveals_the_secret() {
        let parsed: SecretBytes = serde_json::from_value(encoded().into()).unwrap();
        let rendered = format!("{parsed:?}");

        assert!(rendered.contains("[redacted]"), "got {rendered}");
        // The bytes must not appear in any encoding a log scraper would see.
        assert!(
            !rendered.contains("nullifier"),
            "plaintext leaked: {rendered}"
        );
        assert!(!rendered.contains(&encoded()), "base64 leaked: {rendered}");
    }

    #[test]
    fn round_trips_base64() {
        let parsed: SecretBytes = serde_json::from_value(encoded().into()).unwrap();
        assert_eq!(parsed.expose(), SECRET);
    }

    #[test]
    fn rejects_malformed_base64() {
        let result: Result<SecretBytes, _> = serde_json::from_value("not base64!!!".into());
        assert!(result.is_err());
    }
}
