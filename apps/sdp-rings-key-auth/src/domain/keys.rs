//! In-memory Rings key material.

use std::fmt;

use zeroize::{Zeroize as _, ZeroizeOnDrop};
use zolana_keypair::ViewingKey;

/// P-256 viewing secret width.
pub const VIEWING_SECRET_BYTES: usize = 32;
/// BN254 nullifier secret width.
pub const NULLIFIER_SECRET_BYTES: usize = 31;

/// A fixed-width secret that zeroizes its owned storage on drop.
///
/// It intentionally implements neither `Serialize` nor `Deserialize`. Network
/// release is available only through reviewed gateway-specific wrappers.
#[derive(ZeroizeOnDrop)]
pub struct SecretBytes<const N: usize>([u8; N]);

impl<const N: usize> SecretBytes<N> {
    /// Copies validated bytes into owned storage and clears the caller's buffer.
    pub fn take(bytes: &mut [u8; N]) -> Self {
        let owned = *bytes;
        bytes.zeroize();
        Self(owned)
    }

    /// Borrows plaintext key bytes at an explicit disclosure point.
    pub fn expose(&self) -> &[u8; N] {
        &self.0
    }
}

impl<const N: usize> fmt::Debug for SecretBytes<N> {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "SecretBytes([redacted]; {N} bytes)")
    }
}

/// A 32-byte P-256 viewing secret.
pub type ViewingSecret = SecretBytes<VIEWING_SECRET_BYTES>;
/// A 31-byte BN254 nullifier secret.
pub type NullifierSecret = SecretBytes<NULLIFIER_SECRET_BYTES>;

/// A viewing-key generation and its secret.
pub struct IndexedViewingKey {
    index: u32,
    key: ViewingSecret,
}

impl IndexedViewingKey {
    /// Creates an indexed viewing key.
    pub const fn new(index: u32, key: ViewingSecret) -> Self {
        Self { index, key }
    }

    /// Stable append-only generation number.
    pub const fn index(&self) -> u32 {
        self.index
    }

    /// Borrows the viewing secret for an authorized operation.
    pub const fn key(&self) -> &ViewingSecret {
        &self.key
    }
}

impl fmt::Debug for IndexedViewingKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("IndexedViewingKey")
            .field("index", &self.index)
            .field("key", &"[redacted]")
            .finish()
    }
}

/// All Rings key material released for one request stage.
pub struct KeyMaterial {
    viewing_keys: Vec<IndexedViewingKey>,
    nullifier_key: NullifierSecret,
}

impl KeyMaterial {
    /// Creates request-scoped material from decrypted secrets.
    pub fn new(
        viewing_keys: Vec<IndexedViewingKey>,
        nullifier_key: NullifierSecret,
    ) -> Result<Self, KeyMaterialError> {
        if viewing_keys.is_empty() {
            return Err(KeyMaterialError::NoViewingKeys);
        }
        if viewing_keys
            .windows(2)
            .any(|pair| pair[0].index() >= pair[1].index())
        {
            return Err(KeyMaterialError::InvalidViewingKeyOrder);
        }
        if viewing_keys
            .iter()
            .any(|key| ViewingKey::from_bytes(key.key().expose()).is_err())
        {
            return Err(KeyMaterialError::InvalidViewingSecret);
        }

        Ok(Self {
            viewing_keys,
            nullifier_key,
        })
    }

    /// Viewing-key generations in stable ascending order.
    pub fn viewing_keys(&self) -> &[IndexedViewingKey] {
        &self.viewing_keys
    }

    /// Nullifier secret used for witness construction.
    pub const fn nullifier_key(&self) -> &NullifierSecret {
        &self.nullifier_key
    }
}

/// Invalid decrypted key material.
#[derive(Debug, thiserror::Error)]
pub enum KeyMaterialError {
    /// A wallet must retain at least one viewing-key generation.
    #[error("at least one viewing-key generation is required")]
    NoViewingKeys,
    /// Generation indices must be unique and strictly ascending.
    #[error("viewing-key generations must be strictly ascending")]
    InvalidViewingKeyOrder,
    /// A viewing secret must be a valid non-zero P-256 scalar.
    #[error("viewing secret is not a valid P-256 scalar")]
    InvalidViewingSecret,
}

impl fmt::Debug for KeyMaterial {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("KeyMaterial")
            .field(
                "viewing_keys",
                &format_args!("[redacted; {}]", self.viewing_keys.len()),
            )
            .field("nullifier_key", &"[redacted]")
            .finish()
    }
}
