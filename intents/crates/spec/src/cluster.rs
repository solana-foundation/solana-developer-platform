//! The clusters that have a name. An implementation names its cluster by genesis hash, and a message names
//! it by its name, or by the hash when it has none. A program and an offchain reader use the same
//! table, so both map a name and a hash the same way.

use crate::Address;

/// `5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d`.
pub const MAINNET: Address = Address([
    69, 41, 105, 152, 166, 248, 226, 167, 132, 219, 93, 159, 149, 225, 143, 194, 63, 112, 68, 26, 16, 57, 68, 104, 1,
    8, 152, 121, 176, 140, 126, 240,
]);
/// `EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG`.
pub const DEVNET: Address = Address([
    206, 89, 219, 80, 128, 252, 44, 109, 59, 207, 124, 169, 7, 18, 211, 194, 229, 230, 194, 143, 39, 240, 223, 187,
    153, 83, 189, 176, 137, 76, 3, 171,
]);
/// `4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY`.
pub const TESTNET: Address = Address([
    58, 19, 46, 206, 16, 48, 94, 193, 131, 7, 37, 80, 47, 162, 183, 231, 235, 129, 87, 233, 18, 61, 76, 31, 101, 74,
    113, 120, 113, 97, 220, 33,
]);

const NAMED: [(&str, Address); 3] = [("mainnet", MAINNET), ("devnet", DEVNET), ("testnet", TESTNET)];

/// The name of the cluster with this genesis hash, when it has one.
pub fn name(genesis_hash: &Address) -> Option<&'static str> {
    NAMED.iter().find(|(_, hash)| hash == genesis_hash).map(|(name, _)| *name)
}

/// The genesis hash of the cluster with this name.
pub fn genesis_hash(name: &str) -> Option<Address> {
    NAMED.iter().find(|(named, _)| *named == name).map(|(_, hash)| *hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_name_maps_to_its_hash_and_back() {
        for (named, hash) in NAMED {
            assert_eq!(genesis_hash(named), Some(hash));
            assert_eq!(name(&hash), Some(named));
        }

        assert_eq!(name(&Address([1; 32])), None);
        assert_eq!(genesis_hash("localnet"), None);
    }
}
