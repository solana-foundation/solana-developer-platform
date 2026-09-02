//! Protocol-valid generation of independent Rings key material.

use rand::{CryptoRng, RngCore, rngs::OsRng};
use zeroize::Zeroizing;
use zolana_keypair::{NullifierKey, ViewingKey};

use crate::domain::keys::{
    IndexedViewingKey, KeyMaterial, KeyMaterialError, NullifierSecret, ViewingSecret,
};

/// Public halves derived alongside newly generated secret material.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GeneratedPublicKeys {
    /// Compressed SEC1 P-256 viewing public key.
    pub viewing_public_key: [u8; 33],
    /// Poseidon-derived nullifier public key.
    pub nullifier_public_key: [u8; 32],
}

/// One fresh initial Rings key set and its public halves.
#[derive(Debug)]
pub struct GeneratedKeyMaterial {
    /// Initial viewing generation and nullifier secret.
    pub key_material: KeyMaterial,
    /// Public values safe to persist and register on chain.
    pub public_keys: GeneratedPublicKeys,
}

/// Generates independent Rings keys with the operating system RNG.
pub struct ZolanaKeyGenerator;

impl ZolanaKeyGenerator {
    /// Generates viewing generation zero and one independent nullifier key.
    pub fn generate() -> Result<GeneratedKeyMaterial, KeyGenerationError> {
        Self::generate_with_rng(&mut OsRng)
    }

    fn generate_with_rng<R: CryptoRng + RngCore>(
        rng: &mut R,
    ) -> Result<GeneratedKeyMaterial, KeyGenerationError> {
        let viewing_key = loop {
            let mut candidate = Zeroizing::new([0u8; 32]);
            rng.try_fill_bytes(candidate.as_mut())
                .map_err(KeyGenerationError::Entropy)?;
            if let Ok(key) = ViewingKey::from_bytes(&candidate) {
                break key;
            }
        };
        let viewing_public_key = *viewing_key.pubkey().as_bytes();
        let mut viewing_secret = viewing_key.secret_bytes();

        let mut nullifier_bytes = [0u8; 31];
        rng.try_fill_bytes(&mut nullifier_bytes)
            .map_err(KeyGenerationError::Entropy)?;
        let nullifier_key = NullifierKey::from_secret(nullifier_bytes);
        let nullifier_public_key = nullifier_key.pubkey()?;

        let key_material = KeyMaterial::new(
            vec![IndexedViewingKey::new(
                0,
                ViewingSecret::take(&mut viewing_secret),
            )],
            NullifierSecret::take(&mut nullifier_bytes),
        )?;

        Ok(GeneratedKeyMaterial {
            key_material,
            public_keys: GeneratedPublicKeys {
                viewing_public_key,
                nullifier_public_key,
            },
        })
    }
}

/// Failure to generate or derive protocol-valid Rings keys.
#[derive(Debug, thiserror::Error)]
pub enum KeyGenerationError {
    /// The operating system random source was unavailable.
    #[error("operating system random source is unavailable")]
    Entropy(#[source] rand::Error),
    /// Zolana rejected generated material or failed public-key derivation.
    #[error("zolana key derivation failed")]
    Zolana(#[from] zolana_keypair::KeypairError),
    /// Generated material violated the key-authority's domain invariants.
    #[error("generated key material violated domain invariants")]
    Material(#[from] KeyMaterialError),
}

#[cfg(test)]
mod tests {
    use rand::{CryptoRng, RngCore};

    use super::{KeyGenerationError, ZolanaKeyGenerator};

    struct FailingRng;

    impl RngCore for FailingRng {
        fn next_u32(&mut self) -> u32 {
            panic!("generation must use fallible RNG methods")
        }

        fn next_u64(&mut self) -> u64 {
            panic!("generation must use fallible RNG methods")
        }

        fn fill_bytes(&mut self, _destination: &mut [u8]) {
            panic!("generation must use fallible RNG methods")
        }

        fn try_fill_bytes(&mut self, _destination: &mut [u8]) -> Result<(), rand::Error> {
            Err(rand::Error::new(std::io::Error::other(
                "entropy unavailable",
            )))
        }
    }

    impl CryptoRng for FailingRng {}

    #[test]
    fn entropy_failures_are_returned() {
        let error = ZolanaKeyGenerator::generate_with_rng(&mut FailingRng)
            .expect_err("entropy failure must be returned");

        assert!(matches!(error, KeyGenerationError::Entropy(_)));
    }
}
