//! The checks that `Implementation::parse` runs. After them, every accessor of the view returns
//! `Ok`, and every index that an entry holds names an entry that exists.

use super::account::AddressSource;
use super::segment::Segment;
use super::view::Implementation;
use super::wire::{
    AccountV1, AppliesKind, AppliesV1, CheckKind, InstructionV1, PostConditionV1, RecipeKind, SegmentV1,
    MAX_DISCRIMINATOR,
};
use crate::{SpecError, ValueRef, ValueSource};

/// The table lengths that bound an index.
#[derive(Clone, Copy)]
struct Counts {
    accounts: usize,
    addresses: usize,
    literals: usize,
}

impl Implementation<'_> {
    pub(super) fn validate(&self) -> Result<(), SpecError> {
        self.name()?;
        self.message()?;
        self.validate_recipe()?;

        let counts = Counts {
            accounts: self.accounts()?.len(),
            addresses: self.addresses()?.len(),
            literals: self.literals()?.len(),
        };

        self.accounts()?
            .iter()
            .enumerate()
            .try_for_each(|(position, account)| self.check_account(counts, position, account))?;
        self.instructions()?.iter().try_for_each(|instruction| self.check_instruction(counts, instruction))?;

        self.applies()?.iter().try_for_each(|applies| check_applies(counts, applies))?;
        self.post_conditions()?.iter().try_for_each(|condition| self.check_post_condition(counts, condition))?;

        self.output_bindings()?.iter().try_for_each(|binding| check_index(binding.account, counts.accounts))?;
        self.literals()?.iter().try_for_each(|literal| self.text(literal.bytes).map(|_| ()))
    }

    fn validate_recipe(&self) -> Result<(), SpecError> {
        let instruction_count = self.instructions()?.len();
        let has_url = !self.url()?.is_empty();

        let fits = match self.recipe()? {
            RecipeKind::Static => instruction_count > 0 && !has_url,
            RecipeKind::Program => instruction_count == 1 && !has_url,
            RecipeKind::Remote => instruction_count == 0 && self.accounts()?.is_empty() && has_url,
        };

        if !fits {
            return Err(SpecError::BadRecipe);
        }

        Ok(())
    }

    /// An account can name only accounts before it, so resolving the table in order never loops.
    fn check_account(&self, counts: Counts, position: usize, account: &AccountV1) -> Result<(), SpecError> {
        account.check_flags()?;
        self.text(account.name)?;

        let earlier = Counts { accounts: position, ..counts };

        match account.address()? {
            AddressSource::Value(value) => check_value(earlier, value),
            AddressSource::Static { address } => check_index(address, counts.addresses),
            AddressSource::Pda { program, seeds } => {
                check_value(earlier, program)?;
                self.seeds(seeds)?.iter().try_for_each(|seed| self.check_segment(earlier, seed))
            }
            AddressSource::Ata { owner, mint, token_program } => {
                [owner, mint, token_program].into_iter().try_for_each(|value| check_value(earlier, value))
            }
            AddressSource::HasOne { account, owner, .. } => {
                check_index(account, position)?;
                check_index(owner, counts.addresses)
            }
        }
    }

    fn check_instruction(&self, counts: Counts, instruction: &InstructionV1) -> Result<(), SpecError> {
        check_index(instruction.program, counts.accounts)?;

        self.instruction_accounts(instruction)?
            .iter()
            .try_for_each(|account| check_index(*account, counts.accounts))?;
        self.instruction_segments(instruction)?.iter().try_for_each(|segment| self.check_segment(counts, segment))
    }

    fn check_segment(&self, counts: Counts, segment: &SegmentV1) -> Result<(), SpecError> {
        match segment.decode()? {
            Segment::Literal(bytes) => self.text(bytes).map(|_| ()),
            Segment::Reference { value, .. } => check_value(counts, value),
            Segment::AccountBytes { account, owner, .. } => {
                check_index(account, counts.accounts)?;
                check_index(owner, counts.addresses)
            }
        }
    }

    fn check_post_condition(&self, counts: Counts, condition: &PostConditionV1) -> Result<(), SpecError> {
        self.text(condition.message)?;
        condition.args.iter().try_for_each(|arg| check_value(counts, ValueRef::try_from(*arg)?))?;

        if CheckKind::try_from(condition.check)? == CheckKind::InvokesOnly {
            condition.programs.within(counts.addresses)?;
        }

        Ok(())
    }
}

fn check_applies(counts: Counts, applies: &AppliesV1) -> Result<(), SpecError> {
    let value = ValueRef::try_from(applies.value)?;

    if applies.discriminator_len > MAX_DISCRIMINATOR {
        return Err(SpecError::BadCode);
    }

    match AppliesKind::try_from(applies.kind)? {
        AppliesKind::Owner => {
            check_value(counts, value)?;
            check_index(applies.owner, counts.addresses)
        }
        AppliesKind::InputEquals => {
            check_input(value)?;
            check_index(applies.owner, counts.addresses)
        }
        AppliesKind::InputPresent | AppliesKind::InputAbsent => check_input(value),
    }
}

/// An input or output index is checked against the interface, which this document does not hold.
fn check_value(counts: Counts, value: ValueRef) -> Result<(), SpecError> {
    let index = usize::from(value.index);

    let exists = match value.source {
        ValueSource::None => index == 0,
        ValueSource::Input | ValueSource::Output => true,
        ValueSource::Payer => index <= 1,
        ValueSource::Account => index < counts.accounts,
        ValueSource::Address => index < counts.addresses,
        ValueSource::Literal => index < counts.literals,
    };

    if !exists {
        return Err(SpecError::BadIndex);
    }

    Ok(())
}

fn check_input(value: ValueRef) -> Result<(), SpecError> {
    if value.source != ValueSource::Input {
        return Err(SpecError::BadIndex);
    }

    Ok(())
}

fn check_index(index: u8, len: usize) -> Result<(), SpecError> {
    if usize::from(index) >= len {
        return Err(SpecError::BadIndex);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::test_support::Fixture;
    use crate::{AccountSourceKind, Implementation, InstructionV1, RangeV1, RecipeKind, SpecError};

    #[test]
    fn refuses_an_instruction_account_outside_the_table() {
        let mut fixture = Fixture::system_transfer();
        fixture.instruction_accounts = vec![0, 5];

        assert_eq!(Implementation::parse(&fixture.build()).err(), Some(SpecError::BadIndex));
    }

    #[test]
    fn refuses_a_has_one_that_reads_a_later_account() {
        let mut fixture = Fixture::system_transfer();
        let first = fixture.accounts.first_mut().unwrap();
        first.source = AccountSourceKind::HasOne.into();
        first.payload = [1, 0, 8, 0, 0, 0];

        assert_eq!(Implementation::parse(&fixture.build()).err(), Some(SpecError::BadIndex));
    }

    #[test]
    fn refuses_a_program_recipe_with_two_instructions() {
        let mut fixture = Fixture::system_transfer();
        fixture.recipe = RecipeKind::Program;
        let instruction = InstructionV1 {
            program: 2,
            accounts: RangeV1 { first: 0, count: 2 },
            segments: RangeV1 { first: 0, count: 2 },
        };
        fixture.instructions = vec![instruction, instruction];

        assert_eq!(Implementation::parse(&fixture.build()).err(), Some(SpecError::BadRecipe));
    }

    #[test]
    fn refuses_a_static_recipe_with_a_url() {
        let mut fixture = Fixture::system_transfer();
        fixture.url = fixture.text(b"https://example.invalid");

        assert_eq!(Implementation::parse(&fixture.build()).err(), Some(SpecError::BadRecipe));
    }

    #[test]
    fn refuses_an_unknown_account_source() {
        let mut fixture = Fixture::system_transfer();
        fixture.accounts.first_mut().unwrap().source = 9;

        assert_eq!(Implementation::parse(&fixture.build()).err(), Some(SpecError::BadCode));
    }
}
