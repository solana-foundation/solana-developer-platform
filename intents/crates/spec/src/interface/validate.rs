//! The checks that `Interface::parse` runs. After them, every accessor of the view returns `Ok`.

use super::view::Interface;
use super::wire::{InputV1, OutputV1, INPUT_OPTIONAL, INPUT_SIGNER};
use crate::counts::Counts;
use crate::{BaseType, CheckKind, PostConditionV1, SpecError, ValueSource, ValueType};

impl Interface<'_> {
    pub(super) fn validate(&self) -> Result<(), SpecError> {
        self.name()?;
        self.display()?;

        let inputs = self.inputs()?;
        let outputs = self.outputs()?;
        let counts = Counts {
            inputs: Some(inputs.len()),
            outputs: Some(outputs.len()),
            accounts: 0,
            addresses: self.addresses()?.len(),
            literals: self.literals()?.len(),
            bumps: false,
        };

        inputs.iter().try_for_each(|input| self.check_input(counts, input))?;
        outputs.iter().try_for_each(|output| self.text(output.name).and(output.value_type()).map(|_| ()))?;

        self.post_conditions()?.iter().try_for_each(|condition| self.check_post_condition(counts, condition))?;
        self.literals()?.iter().try_for_each(|literal| {
            ValueType::try_from(literal.value_type)?;
            self.text(literal.bytes).map(|_| ())
        })
    }

    /// An `amount` display names a mint for an integer, so the display can place the decimal point.
    fn check_input(&self, counts: Counts, input: &InputV1) -> Result<(), SpecError> {
        if input.flags & !(INPUT_SIGNER | INPUT_OPTIONAL) != 0 {
            return Err(SpecError::BadCode);
        }

        self.text(input.name)?;
        let value_type = input.value_type()?;
        let amount_mint = input.amount_mint()?;

        if amount_mint.source == ValueSource::None {
            return Ok(());
        }

        counts.check_value(amount_mint)?;

        let mint_type = match amount_mint.source {
            ValueSource::Input => self.inputs()?.get(usize::from(amount_mint.index)).map(InputV1::value_type),
            ValueSource::Output => self.outputs()?.get(usize::from(amount_mint.index)).map(OutputV1::value_type),
            _ => None,
        }
        .ok_or(SpecError::BadIndex)??;

        if mint_type.base != BaseType::Mint || value_type.array || !is_unsigned(value_type.base) {
            return Err(SpecError::BadIndex);
        }

        Ok(())
    }

    fn check_post_condition(&self, counts: Counts, condition: &PostConditionV1) -> Result<(), SpecError> {
        self.text(condition.message)?;

        match CheckKind::try_from(condition.check)? {
            CheckKind::InvokesOnly => return Err(SpecError::BadCode),
            CheckKind::Delegates => counts.check_value(condition.delegate().try_into()?)?,
            _ if condition.programs.count != 0 => return Err(SpecError::BadCode),
            _ => {}
        }

        condition.args.iter().try_for_each(|arg| counts.check_value((*arg).try_into()?))
    }
}

fn is_unsigned(base: BaseType) -> bool {
    matches!(base, BaseType::U8 | BaseType::U16 | BaseType::U32 | BaseType::U64 | BaseType::U128)
}

#[cfg(test)]
mod tests {
    use crate::test_support::InterfaceFixture;
    use crate::{CheckKind, Interface, SpecError, ValueRefV1};

    #[test]
    fn refuses_an_amount_display_whose_mint_is_not_a_mint() {
        let mut fixture = InterfaceFixture::token_transfer();
        fixture.inputs.get_mut(3).unwrap().amount_mint = ValueRefV1 { source: 1, index: 1 };

        assert_eq!(Interface::parse(&fixture.build()).err(), Some(SpecError::BadIndex));
    }

    #[test]
    fn refuses_invokes_only_in_an_interface() {
        let mut fixture = InterfaceFixture::token_transfer();
        fixture.post_conditions.first_mut().unwrap().check = CheckKind::InvokesOnly.into();

        assert_eq!(Interface::parse(&fixture.build()).err(), Some(SpecError::BadCode));
    }

    #[test]
    fn refuses_a_condition_on_an_input_that_does_not_exist() {
        let mut fixture = InterfaceFixture::token_transfer();
        fixture.post_conditions.first_mut().unwrap().args[0] = ValueRefV1 { source: 1, index: 9 };

        assert_eq!(Interface::parse(&fixture.build()).err(), Some(SpecError::BadIndex));
    }
}
