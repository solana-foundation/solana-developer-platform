//! The checks that `Implementation::parse` runs. After them, every accessor of the view returns
//! `Ok`, and every index that an entry holds names an entry that exists.

use super::account::AddressSource;
use super::segment::Segment;
use super::view::Implementation;
use super::wire::{AccountV1, AppliesKind, AppliesV1, InstructionV1, RecipeKind, SegmentV1, MAX_DISCRIMINATOR};
use crate::counts::{check_index, Counts};
use crate::{CheckKind, PostConditionV1, SpecError, ValueRef, ValueSource};

impl Implementation<'_> {
    pub(super) fn validate(&self) -> Result<(), SpecError> {
        self.name()?;
        self.message()?;
        self.validate_recipe()?;
        self.validate_extension()?;

        let counts = Counts {
            inputs: None,
            outputs: None,
            accounts: self.accounts()?.len(),
            addresses: self.addresses()?.len(),
            literals: self.literals()?.len(),
            bumps: false,
        };

        self.accounts()?
            .iter()
            .enumerate()
            .try_for_each(|(position, account)| self.check_account(counts, position, account))?;
        let call = Counts { bumps: self.recipe()? == RecipeKind::Program, ..counts };
        self.instructions()?.iter().try_for_each(|instruction| self.check_instruction(call, instruction))?;

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
            RecipeKind::Remote | RecipeKind::RemoteTransaction => instruction_count == 0 && has_url,
            RecipeKind::Shielded => instruction_count > 0 && !has_url && self.shielded_outputs_fit()?,
            RecipeKind::Flow => instruction_count == 0 && !has_url && self.accounts()?.is_empty(),
        };

        if !fits {
            return Err(SpecError::BadRecipe);
        }

        Ok(())
    }

    /// Only a flow has an extension area, and it needs spec 1.1.
    fn validate_extension(&self) -> Result<(), SpecError> {
        match (self.recipe()?, self.flow()?) {
            (RecipeKind::Flow, Some(_)) if self.spec_minor() >= 1 => self.validate_flow(self.literals()?.len()),
            (RecipeKind::Flow, _) => Err(SpecError::BadRecipe),
            (_, None) if self.extension().is_empty() => Ok(()),
            _ => Err(SpecError::BadRecipe),
        }
    }

    /// Each output note names the pool as its program, one owner account, and at least the asset and
    /// the amount.
    fn shielded_outputs_fit(&self) -> Result<bool, SpecError> {
        let pool = self.instructions()?.first().map(|instruction| instruction.program);

        Ok(!self.accounts()?.is_empty()
            && self.instructions()?.iter().all(|instruction| {
                Some(instruction.program) == pool && instruction.accounts.count == 1 && instruction.segments.count >= 2
            }))
    }

    /// An account can name only accounts before it, so resolving the table in order never loops.
    fn check_account(&self, counts: Counts, position: usize, account: &AccountV1) -> Result<(), SpecError> {
        account.check_flags()?;
        self.text(account.name)?;

        let earlier = Counts { accounts: position, ..counts };

        match account.address()? {
            AddressSource::Value(value) => earlier.check_value(value),
            AddressSource::Static { address } => check_index(address, counts.addresses),
            AddressSource::Pda { program, seeds } => {
                earlier.check_value(program)?;
                self.seeds(seeds)?.iter().try_for_each(|seed| self.check_segment(earlier, seed))
            }
            AddressSource::Ata { owner, mint, token_program } => {
                [owner, mint, token_program].into_iter().try_for_each(|value| earlier.check_value(value))
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
            Segment::Reference { value, .. } => counts.check_value(value),
            Segment::AccountBytes { account, owner, .. } => {
                check_index(account, counts.accounts)?;
                check_index(owner, counts.addresses)
            }
        }
    }

    fn check_post_condition(&self, counts: Counts, condition: &PostConditionV1) -> Result<(), SpecError> {
        self.text(condition.message)?;
        condition.args.iter().try_for_each(|arg| counts.check_value(ValueRef::try_from(*arg)?))?;

        match CheckKind::try_from(condition.check)? {
            CheckKind::InvokesOnly => {
                condition.programs.within(counts.addresses)?;
            }
            CheckKind::Delegates => counts.check_value(ValueRef::try_from(condition.delegate())?)?,
            _ => {}
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
            counts.check_value(value)?;
            check_index(applies.owner, counts.addresses)
        }
        AppliesKind::InputEquals => {
            check_input(value)?;
            check_index(applies.owner, counts.addresses)
        }
        AppliesKind::InputPresent | AppliesKind::InputAbsent => check_input(value),
    }
}

fn check_input(value: ValueRef) -> Result<(), SpecError> {
    if value.source != ValueSource::Input {
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
