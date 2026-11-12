//! Derives program addresses. A program derives them with the syscall, and other code with
//! `curve25519` in Rust, through the same `solana-address` call.

use sdp_intents_spec::Address;

use crate::value::Bytes;

/// The runtime allows 16 seeds, and the bump takes one of them.
pub(crate) const MAX_SEEDS: usize = 16;

/// `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
pub(crate) const ASSOCIATED_TOKEN_PROGRAM: Address = Address([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142,
    123, 216, 219, 233, 248, 89,
]);

/// `None` when the seeds break a runtime limit or no bump gives an address off the curve.
pub(crate) fn find(seeds: &[Bytes<'_>], program: &Address) -> Option<Address> {
    let mut storage: [&[u8]; MAX_SEEDS] = [&[]; MAX_SEEDS];
    let parts = storage.get_mut(..seeds.len())?;
    parts.iter_mut().zip(seeds).for_each(|(part, seed)| *part = seed.as_slice());

    let program = solana_address::Address::new_from_array(program.0);
    let (address, _bump) = solana_address::Address::try_find_program_address(parts, &program)?;

    Some(Address(address.to_bytes()))
}

pub(crate) fn associated_token_account(owner: &Address, mint: &Address, token_program: &Address) -> Option<Address> {
    let seeds = [Bytes::from_address(owner), Bytes::from_address(token_program), Bytes::from_address(mint)];

    find(&seeds, &ASSOCIATED_TOKEN_PROGRAM)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{self, address};

    #[test]
    fn the_constant_is_the_associated_token_program() {
        assert_eq!(ASSOCIATED_TOKEN_PROGRAM, address(test_support::ASSOCIATED_TOKEN_PROGRAM));
    }

    #[test]
    fn refuses_seventeen_seeds() {
        let seeds = [Bytes::EMPTY; 17];

        assert_eq!(find(&seeds, &Address([1; 32])), None);
    }
}
