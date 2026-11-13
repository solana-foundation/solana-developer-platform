//! The instructions sysvar holds each account's role in the whole transaction, not its role in one
//! instruction. An account is writable or a signer in every instruction when one instruction, or
//! the fee payer slot, makes it so.
//!
//! So each account must have, in the sysvar, the union of its roles in the built instructions, and
//! the intent's fee payer is also a writable signer. `verify_intent` passes its own accounts
//! readonly, and every other instruction after it is built, so the union is every reason that an
//! account can be writable or a signer. A role that the union does not explain fails.

use alloc::vec::Vec;

use sdp_intents_spec::{AccountRole, Address};

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
