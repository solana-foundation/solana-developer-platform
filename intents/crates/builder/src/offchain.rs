//! Derivations by a search for the canonical bump, for offchain code such as tests. A program
//! cannot use them: the module does not compile for Solana. A builder derives with
//! [`crate::Build::associated_token_address`], which takes the bump that `verify_intent` states.

use pinocchio::address::Address;

use crate::programs::ASSOCIATED_TOKEN;
use crate::token::ata_seeds;

pub fn find_associated_token_address(owner: &Address, mint: &Address, token_program: &Address) -> Option<Address> {
    Address::try_find_program_address(&ata_seeds(owner, mint, token_program), &ASSOCIATED_TOKEN)
        .map(|(address, _)| address)
}
