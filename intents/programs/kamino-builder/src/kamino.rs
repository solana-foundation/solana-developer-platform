//! The Kamino programs, and the conversions to the `solana-pubkey` 2 keys and the
//! `solana-instruction` 2 instructions of the interface crates. Both convert through 32-byte arrays.

use alloc::vec::Vec;

use pinocchio::address::Address;
use sdp_intents_builder::{Build, BuildError, Meta};
use solana_instruction_2::{AccountMeta, Instruction};
use solana_pubkey::Pubkey;

pub(crate) const KVAULT: Address = Address::new_from_array(kvault_interface::KVAULT_PROGRAM_ID.to_bytes());
pub(crate) const KLEND: Address = Address::new_from_array(kvault_interface::KLEND_PROGRAM_ID.to_bytes());

pub(crate) fn pubkey(address: &Address) -> Pubkey {
    Pubkey::new_from_array(address.to_bytes())
}

pub(crate) fn address(pubkey: &Pubkey) -> Address {
    Address::new_from_array(pubkey.to_bytes())
}

/// Adds an instruction of an interface crate to the build.
pub(crate) fn push(build: &mut Build<'_>, instruction: &Instruction) -> Result<(), BuildError> {
    let accounts: Vec<Meta> = instruction.accounts.iter().map(meta).collect();

    build.instruction(&address(&instruction.program_id), &accounts, &instruction.data)
}

fn meta(account: &AccountMeta) -> Meta {
    Meta::new(&address(&account.pubkey), account.is_signer, account.is_writable)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_program_constants_are_their_addresses() {
        assert_eq!(KVAULT, Address::from_str_const("KvauGMspG5k6rtzrqqn7WNn3oZdyKqLKwK2XWQ8FLjd"));
        assert_eq!(KLEND, Address::from_str_const("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD"));
    }
}
