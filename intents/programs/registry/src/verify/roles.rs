//! The instructions sysvar holds each account's role in the whole transaction, not its role in one
//! instruction. An account is writable or a signer in every instruction when one instruction, or
//! the fee payer slot, makes it so.
//!
//! So an account that only the span names must have, in the sysvar, the union of its roles in the
//! span, and the intent's fee payer is also a writable signer. An account that an instruction
//! outside the span also names can have more, because the signer reads that instruction.

use alloc::vec::Vec;
use core::ops::Range;

use anchor_lang::prelude::*;
use sdp_intents_spec::{AccountRole, Address};

use crate::error::RegistryError;
use crate::state::spec_address;
use crate::verify::position;

pub struct TransactionRoles {
    entries: Vec<RoleEntry>,
}

struct RoleEntry {
    address: Address,
    role: AccountRole,
}

impl TransactionRoles {
    pub fn new(fee_payer: &Address) -> Self {
        Self { entries: alloc::vec![RoleEntry { address: *fee_payer, role: AccountRole::WritableSigner }] }
    }

    pub fn add(&mut self, address: &Address, role: AccountRole) {
        match self.entries.iter_mut().find(|entry| entry.address == *address) {
            Some(entry) => entry.role = union(entry.role, role),
            None => self.entries.push(RoleEntry { address: *address, role }),
        }
    }

    /// The role that the sysvar must show for `address`.
    pub fn role(&self, address: &Address) -> AccountRole {
        self.entries.iter().find(|entry| entry.address == *address).map_or(AccountRole::Readonly, |entry| entry.role)
    }

    /// Fails unless `actual`, the sysvar's role of `address`, is the role that this union explains.
    pub fn check(
        &self,
        sysvar: &SysvarInstructions,
        span: &Range<usize>,
        address: &anchor_lang::Address,
        actual: AccountRole,
    ) -> Result<()> {
        let expected = self.role(&spec_address(address));

        if actual == expected {
            return Ok(());
        }

        let explained_outside = union(actual, expected) == actual && position::named_outside(sysvar, span, address);
        require!(explained_outside, RegistryError::WrongRole);

        Ok(())
    }
}

fn union(first: AccountRole, second: AccountRole) -> AccountRole {
    AccountRole::new(first.writable() || second.writable(), first.signer() || second.signer())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_role_is_the_union_of_the_instructions_and_the_fee_payer() {
        let fee_payer = Address([1; 32]);
        let account = Address([2; 32]);
        let mut roles = TransactionRoles::new(&fee_payer);

        roles.add(&account, AccountRole::ReadonlySigner);
        roles.add(&account, AccountRole::Writable);
        roles.add(&fee_payer, AccountRole::Readonly);

        assert_eq!(roles.role(&account), AccountRole::WritableSigner);
        assert_eq!(roles.role(&fee_payer), AccountRole::WritableSigner);
        assert_eq!(roles.role(&Address([3; 32])), AccountRole::Readonly);
    }
}
