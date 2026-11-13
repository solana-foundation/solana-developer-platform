//! Derives program addresses. Offchain code finds the canonical bump with `curve25519` in Rust. A
//! program takes the bump that the plan states, because a search costs 1,500 compute units for
//! each bump that it tries. Only the canonical bump is supported: a stated bump derives an address
//! only when its hash is off the curve and the hash of each higher bump is on it. Any other bump
//! derives nothing, so the plan fails.

use sdp_intents_spec::Address;

use crate::value::Bytes;

/// The runtime allows 16 seeds, and the bump takes one of them.
pub(crate) const MAX_SEEDS: usize = 16;

/// `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
pub(crate) const ASSOCIATED_TOKEN_PROGRAM: Address = Address([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142,
    123, 216, 219, 233, 248, 89,
]);

/// The longest seed that the runtime allows.
const MAX_SEED_LEN: usize = 32;
const PDA_MARKER: &[u8] = b"ProgramDerivedAddress";

/// A program address and its canonical bump.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Derived {
    pub(crate) address: Address,
    pub(crate) bump: u8,
}

/// `None` when the seeds break a runtime limit or no bump gives an address off the curve.
pub(crate) fn find(seeds: &[Bytes<'_>], program: &Address) -> Option<Derived> {
    let mut storage: [&[u8]; MAX_SEEDS] = [&[]; MAX_SEEDS];
    let parts = storage.get_mut(..seeds.len())?;
    parts.iter_mut().zip(seeds).for_each(|(part, seed)| *part = seed.as_slice());

    let program = solana_address::Address::new_from_array(program.0);
    let (address, bump) = solana_address::Address::try_find_program_address(parts, &program)?;

    Some(Derived { address: Address(address.to_bytes()), bump })
}

/// `with_bump` for seeds as byte slices, as a builder holds them.
pub fn program_address(seeds: &[&[u8]], bump: u8, program: &Address) -> Option<Address> {
    let mut storage = [Bytes::EMPTY; MAX_SEEDS];
    let parts = storage.get_mut(..seeds.len())?;
    parts.iter_mut().zip(seeds).for_each(|(part, seed)| *part = Bytes::borrowed(seed));

    with_bump(parts, bump, program)
}

/// The address of `seeds` with `bump` under `program`, when `bump` is the canonical bump. Each
/// candidate is one SHA-256 and one curve check, which cost far less than the search's 1,500
/// compute units for each bump.
pub(crate) fn with_bump(seeds: &[Bytes<'_>], bump: u8, program: &Address) -> Option<Address> {
    if seeds.len() >= MAX_SEEDS || seeds.iter().any(|seed| seed.as_slice().len() > MAX_SEED_LEN) {
        return None;
    }

    let higher_on_curve = (u16::from(bump).saturating_add(1)..=255)
        .filter_map(|higher| u8::try_from(higher).ok())
        .all(|higher| solana_address::bytes_are_curve_point(candidate(seeds, higher, program).0));
    let address = candidate(seeds, bump, program);

    (higher_on_curve && !solana_address::bytes_are_curve_point(address.0)).then_some(address)
}

/// The SHA-256 of the seeds, the bump, the program, and the marker, as the runtime derives an
/// address.
fn candidate(seeds: &[Bytes<'_>], bump: u8, program: &Address) -> Address {
    let mut storage: [&[u8]; MAX_SEEDS + 3] = [&[]; MAX_SEEDS + 3];
    let bump = [bump];
    let tail: [&[u8]; 3] = [&bump, &program.0, PDA_MARKER];
    let parts = seeds.iter().map(Bytes::as_slice).chain(tail);
    let used = storage.iter_mut().zip(parts).map(|(part, seed)| *part = seed).count();

    Address(solana_sha256_hasher::hashv(storage.get(..used).unwrap_or_default()).to_bytes())
}

/// The seeds of the associated token account of `owner` for `mint`.
pub(crate) fn ata_seeds<'s>(owner: &'s Address, mint: &'s Address, token_program: &'s Address) -> [Bytes<'s>; 3] {
    [Bytes::from_address(owner), Bytes::from_address(token_program), Bytes::from_address(mint)]
}

pub(crate) fn associated_token_account(owner: &Address, mint: &Address, token_program: &Address) -> Option<Address> {
    find(&ata_seeds(owner, mint, token_program), &ASSOCIATED_TOKEN_PROGRAM).map(|derived| derived.address)
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
        assert_eq!(with_bump(&seeds[..16], 255, &Address([1; 32])), None);
    }

    /// The canonical bump derives the address that the search finds.
    #[test]
    fn a_bump_derives_the_address_that_the_search_finds() {
        let owner = Address([3; 32]);
        let mint = Address([4; 32]);
        let token = address(test_support::TOKEN_PROGRAM);
        let seeds = ata_seeds(&owner, &mint, &token);
        let found = find(&seeds, &ASSOCIATED_TOKEN_PROGRAM).unwrap();

        assert_eq!(with_bump(&seeds, found.bump, &ASSOCIATED_TOKEN_PROGRAM), Some(found.address));
    }

    /// A bump below the canonical one derives nothing, even when its hash is off the curve, and so
    /// does a bump above it.
    #[test]
    fn only_the_canonical_bump_derives_an_address() {
        let token = address(test_support::TOKEN_PROGRAM);
        let derivations = (0u8..64).map(|byte| {
            let owner = Address([byte; 32]);
            let mint = Address([4; 32]);
            let seeds = ata_seeds(&owner, &mint, &token);
            let found = find(&seeds, &ASSOCIATED_TOKEN_PROGRAM).unwrap();
            let others = (0u8..=255).filter(|bump| *bump != found.bump);

            others.filter(|bump| with_bump(&seeds, *bump, &ASSOCIATED_TOKEN_PROGRAM).is_some()).count()
        });

        assert_eq!(derivations.sum::<usize>(), 0);
    }
}
