//! Protocol-valid Rings key generation tests.

use base64::{Engine as _, engine::general_purpose::STANDARD};
use sdp_rings_key_auth::domain::generation::ZolanaKeyGenerator;
use serde::Deserialize;
use zolana_keypair::{NullifierKey, ViewingKey};

#[test]
fn generated_material_round_trips_through_zolana() {
    let generated = ZolanaKeyGenerator::generate().expect("OS-backed generation succeeds");

    assert_eq!(generated.key_material.viewing_keys().len(), 1);
    assert_eq!(generated.key_material.viewing_keys()[0].index(), 0);

    let viewing = ViewingKey::from_bytes(generated.key_material.viewing_keys()[0].key().expose())
        .expect("generated viewing secret is a valid P-256 scalar");
    assert_eq!(
        viewing.pubkey().as_bytes(),
        &generated.public_keys.viewing_public_key
    );

    let nullifier = NullifierKey::from_secret(*generated.key_material.nullifier_key().expose());
    assert_eq!(
        nullifier.pubkey().expect("nullifier public key derives"),
        generated.public_keys.nullifier_public_key
    );
}

#[test]
fn independent_generations_do_not_reuse_secrets() {
    let first = ZolanaKeyGenerator::generate().expect("first generation succeeds");
    let second = ZolanaKeyGenerator::generate().expect("second generation succeeds");

    assert!(
        first.key_material.viewing_keys()[0].key().expose()
            != second.key_material.viewing_keys()[0].key().expose(),
        "independent generations reused a viewing secret"
    );
    assert!(
        first.key_material.nullifier_key().expose() != second.key_material.nullifier_key().expose(),
        "independent generations reused a nullifier secret"
    );
}

#[test]
fn fixed_secrets_match_the_protocol_public_key_vector() {
    // Scalar one maps to the standard NIST P-256 generator. The nullifier
    // vector is the golden value published by the pinned Zolana revision.
    let vector: KeyVector = serde_json::from_str(include_str!("fixtures/zolana-key-vector.json"))
        .expect("key vector is valid JSON");

    let viewing_secret = decode_exact::<32>(&vector.viewing_secret);
    let viewing_key =
        ViewingKey::from_bytes(&viewing_secret).expect("vector contains a valid P-256 scalar");
    assert_eq!(
        STANDARD.encode(viewing_key.pubkey().as_bytes()),
        vector.viewing_public_key
    );

    let nullifier_secret = decode_exact::<31>(&vector.nullifier_secret);
    let nullifier_key = NullifierKey::from_secret(nullifier_secret);
    assert_eq!(
        STANDARD.encode(
            nullifier_key
                .pubkey()
                .expect("nullifier public key derives")
        ),
        vector.nullifier_public_key
    );
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct KeyVector {
    viewing_secret: String,
    viewing_public_key: String,
    nullifier_secret: String,
    nullifier_public_key: String,
}

#[allow(clippy::expect_used)]
fn decode_exact<const N: usize>(encoded: &str) -> [u8; N] {
    STANDARD
        .decode(encoded)
        .expect("vector value is valid base64")
        .try_into()
        .unwrap_or_else(|_| panic!("vector value must decode to exactly {N} bytes"))
}
