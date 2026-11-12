//! A 32-byte Solana address. The crate defines its own type so that it depends only on `bytemuck`.
//! Programs convert to and from `solana_address::Address` through the bytes.

use bytemuck::{Pod, Zeroable};

#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Pod, Zeroable)]
pub struct Address(pub [u8; 32]);

impl From<[u8; 32]> for Address {
    fn from(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }
}

impl From<Address> for [u8; 32] {
    fn from(address: Address) -> Self {
        address.0
    }
}
