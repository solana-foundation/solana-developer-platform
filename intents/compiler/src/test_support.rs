//! The definitions in `intents/definitions`, and a catalog that compiles them.

use sdp_intents_spec::Address;

use crate::{compile_interface, Catalog};

pub(crate) const SOLANA_ORG: Address = Address([7; 32]);

pub(crate) const TOKEN_TRANSFER: &str =
    include_str!("../../definitions/solana.org/interfaces/token.transfer/1.0.0.json");
pub(crate) const SYSTEM_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/system-transfer/1.0.0.json");
pub(crate) const SPL_TOKEN_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json");
pub(crate) const TOKEN_2022_TRANSFER: &str =
    include_str!("../../definitions/solana.org/implementations/token-2022-transfer/1.0.0.json");

pub(crate) fn publishers() -> Catalog {
    Catalog::default().with_publisher("solana.org", SOLANA_ORG)
}

/// A catalog with `solana.org` and the `token.transfer` interface.
pub(crate) fn catalog() -> Catalog {
    let mut catalog = publishers();
    let interface = compile_interface(TOKEN_TRANSFER, &catalog).unwrap();
    catalog.add_interface(interface);

    catalog
}

/// Replaces the one occurrence of `from` in `text`, so that a test changes exactly one thing.
pub(crate) fn edit(text: &str, from: &str, to: &str) -> String {
    assert_eq!(text.matches(from).count(), 1, "`{from}` must occur once");

    text.replace(from, to)
}
