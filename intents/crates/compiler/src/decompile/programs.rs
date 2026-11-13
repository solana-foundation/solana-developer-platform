//! The program accounts that the compiler adds. JSON names an instruction's program by its address.
//! When no earlier account holds that address as a static address, the compiler appends a readonly
//! account for it, so the JSON states only the accounts before the added ones.

use sdp_intents_spec::wire::{AccountV1, InstructionV1};
use sdp_intents_spec::{AddressSource, Segment, ValueSource};

use super::implementation::Document;
use super::DecompileError;

/// The name that the compiler gives an added program account.
#[derive(Clone, Copy)]
pub(super) enum ProgramName {
    /// A static instruction's program account has the program's address as its name.
    Address,
    /// A builder call's program account is named `program`.
    Builder,
}

impl Document<'_, '_> {
    /// The fewest accounts that compile, with the instructions, to the account table.
    pub(super) fn declared_accounts(&self) -> Result<usize, DecompileError> {
        (0..=self.view.accounts()?.len())
            .find_map(|declared| {
                self.reproduces(declared, ProgramName::Address).map(|ok| ok.then_some(declared)).transpose()
            })
            .unwrap_or(Err(DecompileError::Unrepresentable(
                "an instruction program that is not the first account with its address",
            )))
    }

    /// Whether the first `declared` accounts, then the instructions, compile to the account table.
    /// An instruction can name only the accounts that exist when the compiler reads it.
    pub(super) fn reproduces(&self, declared: usize, naming: ProgramName) -> Result<bool, DecompileError> {
        let accounts = self.view.accounts()?;
        let mut known = declared;
        let mut pool_end = 0;

        for instruction in self.view.instructions()? {
            let Some(address) = accounts.get(usize::from(instruction.program)).and_then(static_address) else {
                return Ok(false);
            };

            let held = accounts
                .get(..known)
                .and_then(|earlier| earlier.iter().position(|account| static_address(account) == Some(address)));

            let index = match held {
                Some(index) => index,
                None if self.is_added_program(accounts.get(known), address, naming, pool_end)? => {
                    let added = known;
                    known = known.saturating_add(1);
                    added
                }
                None => return Ok(false),
            };

            let named_later = self.last_account(instruction)?.is_some_and(|account| usize::from(account) >= known);

            if index != usize::from(instruction.program) || named_later {
                return Ok(false);
            }

            pool_end = pool_end.max(self.literals_end(instruction)?);
        }

        Ok(known == accounts.len())
    }

    /// An added account is readonly and unsigned, and has the program's name. Its name follows in the
    /// pool the literals of the instructions before it. A declared account comes before them all.
    fn is_added_program(
        &self,
        account: Option<&AccountV1>,
        address: u8,
        naming: ProgramName,
        pool_end: usize,
    ) -> Result<bool, DecompileError> {
        let Some(account) = account else {
            return Ok(false);
        };

        let name = match naming {
            ProgramName::Address => self.names.address(address)?,
            ProgramName::Builder => "program".to_owned(),
        };

        Ok(static_address(account) == Some(address)
            && !account.writable()
            && !account.signer()
            && self.view.text(account.name)? == name.as_bytes()
            && usize::from(account.name.offset.get()) >= pool_end)
    }

    /// The highest account index that the instruction names in its accounts or its data.
    fn last_account(&self, instruction: &InstructionV1) -> Result<Option<u8>, DecompileError> {
        let listed = self.view.instruction_accounts(instruction)?.iter().copied().max();
        let in_data = self
            .view
            .instruction_segments(instruction)?
            .iter()
            .filter_map(|segment| match segment.decode() {
                Ok(Segment::Reference { value, .. }) if value.source == ValueSource::Account => Some(value.index),
                Ok(Segment::AccountBytes { account, .. }) => Some(account),
                _ => None,
            })
            .max();

        Ok(listed.max(in_data))
    }

    /// The pool offset after the last literal of the instruction's data.
    fn literals_end(&self, instruction: &InstructionV1) -> Result<usize, DecompileError> {
        let end = self
            .view
            .instruction_segments(instruction)?
            .iter()
            .filter_map(|segment| match segment.decode() {
                Ok(Segment::Literal(bytes)) => {
                    Some(usize::from(bytes.offset.get()).saturating_add(usize::from(bytes.len.get())))
                }
                _ => None,
            })
            .max();

        Ok(end.unwrap_or_default())
    }
}

fn static_address(account: &AccountV1) -> Option<u8> {
    match account.address() {
        Ok(AddressSource::Static { address }) => Some(address),
        _ => None,
    }
}
