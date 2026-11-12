//! The definitions in `intents/definitions`, and a catalog that compiles them.

use sdp_intents_spec::Address;

use crate::Catalog;

pub(crate) const SOLANA_ORG: Address = Address([7; 32]);

pub(crate) const TOKEN_TRANSFER: &str =
    include_str!("../../definitions/solana.org/interfaces/token.transfer/1.0.0.json");
pub(crate) const SYSTEM_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/system-transfer/1.0.0.json");
pub(crate) const SPL_TOKEN_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json");
pub(crate) const TOKEN_2022_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/token-2022-transfer/1.0.0.json");

pub(crate) const INTENT_SPL_TRANSFER: &str = include_str!("../../fixtures/intents/spl-token-transfer.json");

pub(crate) fn publishers() -> Catalog {
    Catalog::default().with_publisher("solana.org", SOLANA_ORG)
}

/// A catalog with `solana.org` and the `token.transfer` interface.
pub(crate) fn catalog() -> Catalog {
    let mut catalog = publishers();
    catalog.compile_interface(TOKEN_TRANSFER).unwrap();

    catalog
}

/// A catalog with the interface and every implementation.
pub(crate) fn full_catalog() -> Catalog {
    let mut catalog = catalog();
    for text in [SYSTEM_TRANSFER, SPL_TOKEN_TRANSFER, TOKEN_2022_TRANSFER] {
        catalog.compile_implementation(text).unwrap();
    }

    catalog
}

/// Replaces the one occurrence of `from` in `text`, so that a test changes exactly one thing.
pub(crate) fn edit(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "`{from}` must occur once");

    text.replace(from, to)
}
