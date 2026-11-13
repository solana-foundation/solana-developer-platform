//! The snapshot and assertion instructions of a segment, from its guards.
//!
//! Each guarded value takes one slot of memory. A lamport slot holds 8 bytes. A token slot holds
//! the amount, or bytes 32 to 165 of the account when its authorities are fixed: the owner, the
//! amount, the delegate, and the close authority. The snapshots write the highest slot first, so
//! the first write creates memory at its full size, and no later write charges the fee payer.

use alloc::vec::Vec;

use sdp_intents_engine::Recipe;
use sdp_intents_spec::Address;

use crate::guards::{GuardInputs, GuardedAccount, Guards, TokenGuard};
use crate::wire::{amount_at_least, LighthouseInstruction, Memory, Source, TOKEN_AMOUNT_OFFSET};
use crate::GuardError;

const LAMPORTS_LEN: u64 = 8;
const AMOUNT_LEN: u16 = 8;
/// Bytes 32 to 165 of a token account.
const AUTHORITIES_START: u16 = 32;
const AUTHORITIES_LEN: u16 = 133;
const AMOUNT_IN_AUTHORITIES_SLOT: u64 = 32;
const OWNER: Field = Field { data_offset: 32, slot_offset: 0, len: 32 };
const DELEGATE: Field = Field { data_offset: 72, slot_offset: 40, len: 36 };
const CLOSE_AUTHORITY: Field = Field { data_offset: 129, slot_offset: 97, len: 36 };

/// A field of a token account, at `data_offset` in the account and `slot_offset` in a slot of
/// bytes 32 to 165.
#[derive(Clone, Copy)]
struct Field {
    data_offset: u16,
    slot_offset: u64,
    len: u16,
}

/// What the assertions of one segment read.
pub struct Guard<'g, 'a> {
    pub recipe: &'g Recipe<'a>,
    /// The interface's outputs, in borsh.
    pub outputs: &'g [u8],
    pub accounts: &'g [GuardedAccount<'g>],
    /// The most that the rent payer spends on new accounts in the segment.
    pub rent_cap: u64,
    pub memory: Memory,
}

/// The instructions before the built instructions, and the ones after them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Assertions {
    pub snapshots: Vec<LighthouseInstruction>,
    pub checks: Vec<LighthouseInstruction>,
}

/// One snapshot in memory.
struct Slot {
    address: Address,
    offset: u64,
    source: Source,
}

impl Guard<'_, '_> {
    pub fn assertions(&self) -> Result<Assertions, GuardError> {
        let conditions = self.recipe.conditions(self.outputs)?.collect::<Result<Vec<_>, _>>()?;
        let inputs = GuardInputs {
            conditions: &conditions,
            accounts: self.accounts,
            payers: self.recipe.payers(),
            rent_cap: self.rent_cap,
        };
        let guards = inputs.guards()?;
        let slots = layout(&guards)?;
        let payer = self.recipe.payers().fee;

        let snapshots =
            slots.iter().rev().map(|slot| self.memory.write(payer, &slot.address, slot.offset, slot.source)).collect();

        let lamport_checks = guards
            .lamports
            .iter()
            .zip(&slots)
            .map(|(guard, slot)| self.memory.lamports_change(&guard.address, slot.offset, guard.min_change));
        let token_checks = guards
            .tokens
            .iter()
            .zip(slots.iter().skip(guards.lamports.len()))
            .flat_map(|(guard, slot)| self.token_checks(guard, slot.offset));
        let new_account_checks = guards.new_accounts.iter().map(|guard| amount_at_least(&guard.address, guard.min));
        let close = (!slots.is_empty()).then(|| self.memory.close(payer));

        let checks = lamport_checks.chain(token_checks).chain(new_account_checks).chain(close).collect();

        Ok(Assertions { snapshots, checks })
    }

    fn token_checks(&self, guard: &TokenGuard, slot_offset: u64) -> Vec<LighthouseInstruction> {
        let amount_offset =
            if guard.authorities_fixed { slot_offset.saturating_add(AMOUNT_IN_AUTHORITIES_SLOT) } else { slot_offset };
        let amount = guard.min_change.map(|min| self.memory.amount_change(&guard.address, amount_offset, min));
        let fields: &[Field] = if guard.authorities_fixed { &[OWNER, DELEGATE, CLOSE_AUTHORITY] } else { &[] };
        let authorities = fields.iter().map(|field| {
            let offset = slot_offset.saturating_add(field.slot_offset);

            self.memory.bytes_unchanged(&guard.address, offset, field.data_offset, field.len)
        });

        amount.into_iter().chain(authorities).collect()
    }
}

/// The lamport slots, then the token slots, in the order of the guards.
fn layout(guards: &Guards) -> Result<Vec<Slot>, GuardError> {
    let lamports = guards.lamports.iter().map(|guard| (guard.address, Source::Lamports));
    let tokens = guards.tokens.iter().map(|guard| (guard.address, token_source(guard)));
    let mut next = 0u64;

    lamports
        .chain(tokens)
        .map(|(address, source)| {
            let offset = next;
            next = offset.checked_add(source_len(source)).ok_or(GuardError::Overflow)?;

            Ok(Slot { address, offset, source })
        })
        .collect()
}

fn token_source(guard: &TokenGuard) -> Source {
    if guard.authorities_fixed {
        return Source::AccountData { offset: AUTHORITIES_START, len: AUTHORITIES_LEN };
    }

    Source::AccountData { offset: TOKEN_AMOUNT_OFFSET, len: AMOUNT_LEN }
}

fn source_len(source: Source) -> u64 {
    match source {
        Source::Lamports => LAMPORTS_LEN,
        Source::AccountData { len, .. } => u64::from(len),
    }
}

#[cfg(test)]
mod tests {
    use sdp_intents_compiler::Catalog;
    use sdp_intents_engine::Payers;

    use super::*;
    use crate::{GuardError, LIGHTHOUSE_PROGRAM};

    const FROM: [u8; 32] = [1; 32];
    const PAYER: [u8; 32] = [2; 32];
    const MINT: [u8; 32] = [3; 32];
    const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

    struct Documents {
        interface: Vec<u8>,
        implementation: Vec<u8>,
        intent: Vec<u8>,
    }

    fn base58(bytes: [u8; 32]) -> alloc::string::String {
        bs58::encode(bytes).into_string()
    }

    fn spl_transfer() -> Documents {
        let mut catalog = Catalog::default().with_publisher("solana.org", Address([7; 32]));
        let interface = catalog
            .compile_interface(include_str!("../../../definitions/solana.org/interfaces/token.transfer/1.0.0.json"))
            .unwrap()
            .bytes
            .clone();
        let implementation = catalog
            .compile_implementation(include_str!(
                "../../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json"
            ))
            .unwrap()
            .bytes
            .clone();
        let intent = include_str!("../../../fixtures/intents/spl-token-transfer.json")
            .replace("7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", &base58(FROM))
            .replace("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", &base58(MINT));

        Documents { interface, implementation, intent: catalog.compile_intent(&intent).unwrap().bytes }
    }

    fn token_account(authority: [u8; 32], amount: u64) -> Vec<u8> {
        [&MINT[..], &authority, &amount.to_le_bytes(), &[0; 165 - 72]].concat()
    }

    fn token_program() -> Address {
        Address(solana_address::Address::from_str_const(TOKEN_PROGRAM).to_bytes())
    }

    fn assertions(accounts: &[GuardedAccount<'_>], rent_payer: &Address) -> Result<Assertions, GuardError> {
        let documents = spl_transfer();
        let payers = Payers { fee: &Address(PAYER), rent: rent_payer };
        let recipe = Recipe::parse(&documents.interface, &documents.implementation, &documents.intent, payers).unwrap();
        let memory = Memory { address: Address([9; 32]), id: 0, bump: 255 };

        Guard { recipe: &recipe, outputs: &[], accounts, rent_cap: 2_039_280, memory }.assertions()
    }

    #[test]
    fn guards_the_sender_token_account_with_the_amount() {
        let source = token_account(FROM, 500);
        let accounts = [
            GuardedAccount { address: Address([4; 32]), owner: token_program(), lamports: 1, data: &source },
            GuardedAccount { address: Address(PAYER), owner: Address::default(), lamports: 10, data: &[] },
        ];

        let built = assertions(&accounts, &Address(PAYER)).unwrap();

        assert_eq!(built.snapshots.len(), 1);
        assert_eq!(built.checks.len(), 2);
        assert_eq!(built.snapshots[0].data, [0, 0, 255, 0, 0, 64, 0, 8, 0]);
        assert_eq!(
            built.checks[0].data,
            [&[4u8, 0, 1, 0, 64, 6][..], &(-100_000_000i128).to_le_bytes(), &[4]].concat()
        );
        assert_eq!(built.checks[1].data, [1, 0, 255]);
        assert!(built.checks.iter().all(|check| !check.accounts.is_empty()));
        assert_eq!(LIGHTHOUSE_PROGRAM, built.snapshots[0].accounts[0].address);
    }

    /// The sender pays the rent, so its lamports may fall by the rent cap and no more.
    #[test]
    fn a_sender_that_pays_the_rent_may_spend_the_rent_cap() {
        let source = token_account(FROM, 500);
        let accounts = [
            GuardedAccount { address: Address(FROM), owner: Address::default(), lamports: 10, data: &[] },
            GuardedAccount { address: Address([4; 32]), owner: token_program(), lamports: 1, data: &source },
        ];

        let built = assertions(&accounts, &Address(FROM)).unwrap();

        assert_eq!(built.snapshots.len(), 2);
        assert_eq!(built.checks[0].data, [&[4u8, 0, 0, 0, 0][..], &(-2_039_280i128).to_le_bytes(), &[4]].concat());
    }

    #[test]
    fn refuses_an_outflow_from_two_token_accounts() {
        let first = token_account(FROM, 500);
        let second = token_account(FROM, 7);
        let accounts = [
            GuardedAccount { address: Address([4; 32]), owner: token_program(), lamports: 1, data: &first },
            GuardedAccount { address: Address([5; 32]), owner: token_program(), lamports: 1, data: &second },
        ];

        assert_eq!(assertions(&accounts, &Address(PAYER)), Err(GuardError::SeveralAccounts));
    }
}
