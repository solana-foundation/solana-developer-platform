//! The Lighthouse part of a segment. `verify_intent` builds the snapshots and the assertions again
//! from the postconditions, the guarded accounts as they are now, and the rent cap, and each one must
//! equal the instruction at its place: the program, each account's address, and the data. The roles
//! are not compared, because the sysvar holds each account's role in the whole transaction, and
//! Lighthouse checks the roles that it needs.

use alloc::vec::Vec;
use core::ops::Range;

use anchor_lang::prelude::*;
use pinocchio::account::Ref;
use pinocchio::sysvars::instructions::IntrospectedInstruction;
use sdp_intents_engine::Recipe;
use sdp_intents_lighthouse::{guarded_addresses, Guard, GuardedAccount, LighthouseInstruction, Memory, Meta};

use crate::error::RegistryError;
use crate::state::spec_address;

/// Memory for a segment with no snapshots. No instruction then names it.
const NO_MEMORY: Memory = Memory { address: sdp_intents_spec::Address([0; 32]), id: 0, bump: 0 };

pub struct SegmentAssertions<'v, 'a> {
    pub sysvar: &'v SysvarInstructions,
    pub recipe: &'v Recipe<'a>,
    pub outputs: &'v [u8],
    /// Each account of the built instructions with the role that the implementation or the builder gives it.
    pub named: Vec<Meta>,
    pub guarded: &'v [AccountView],
    pub rent_cap: u64,
    /// The snapshots, which come right after `verify_intent`.
    pub snapshots: Range<usize>,
    pub built: &'v Range<usize>,
}

impl SegmentAssertions<'_, '_> {
    /// The position after the last assertion, which ends the segment.
    pub fn verify(self) -> Result<usize> {
        let expected = guarded_addresses(self.named.iter().copied(), self.recipe.payers().fee);
        let passed: Vec<_> = self.guarded.iter().map(|view| spec_address(view.address())).collect();
        require!(passed == expected, RegistryError::WrongGuardedAccounts);

        let data = self
            .guarded
            .iter()
            .map(AccountView::try_borrow)
            .collect::<core::result::Result<Vec<Ref<'_, [u8]>>, _>>()?;
        let accounts: Vec<GuardedAccount<'_>> = self
            .guarded
            .iter()
            .zip(&data)
            .map(|(view, data)| GuardedAccount {
                address: spec_address(view.address()),
                owner: spec_address(view.owner()),
                lamports: view.lamports(),
                data,
            })
            .collect();

        let guard = Guard {
            recipe: self.recipe,
            outputs: self.outputs,
            accounts: &accounts,
            rent_cap: self.rent_cap,
            memory: self.memory()?,
        };
        let assertions = guard.assertions().map_err(|error| {
            msg!("verify_intent: {}", error);
            RegistryError::AssertionsRefused
        })?;

        require!(assertions.snapshots.len() == self.snapshots.len(), RegistryError::WrongAssertions);
        assertions
            .snapshots
            .iter()
            .zip(self.snapshots.clone())
            .try_for_each(|(snapshot, position)| self.compare(snapshot, position))?;

        let end = self.built.end.checked_add(assertions.checks.len()).ok_or(ProgramError::ArithmeticOverflow)?;
        require!(end <= self.sysvar.num_instructions(), RegistryError::SpanPastEnd);
        assertions
            .checks
            .iter()
            .zip(self.built.end..end)
            .try_for_each(|(check, position)| self.compare(check, position))?;

        Ok(end)
    }

    /// The memory account, id, and bump of the first snapshot. Lighthouse derives the address from
    /// the payer, the id, and the bump, so a wrong one fails there.
    fn memory(&self) -> Result<Memory> {
        if self.snapshots.is_empty() {
            return Ok(NO_MEMORY);
        }

        let first = self.sysvar.load_instruction_at(self.snapshots.start)?;
        let memory = first.get_instruction_account_at(3).map_err(|_| RegistryError::WrongAssertions)?;
        let address = spec_address(&memory.key);
        let [_, id, bump] = *first.get_instruction_data().first_chunk::<3>().ok_or(RegistryError::WrongAssertions)?;

        Ok(Memory { address, id, bump })
    }

    fn compare(&self, expected: &LighthouseInstruction, position: usize) -> Result<()> {
        let actual = self.sysvar.load_instruction_at(position)?;
        require!(matches(expected, &actual), RegistryError::WrongAssertions);

        Ok(())
    }
}

fn matches(expected: &LighthouseInstruction, actual: &IntrospectedInstruction<'_>) -> bool {
    actual.get_program_id().as_ref() == sdp_intents_lighthouse::LIGHTHOUSE_PROGRAM.0
        && actual.num_account_metas() == expected.accounts().len()
        && actual.get_instruction_data() == expected.data()
        && expected.accounts().iter().enumerate().all(|(index, meta)| {
            actual.get_instruction_account_at(index).is_ok_and(|account| account.key.as_ref() == meta.address.0)
        })
}
