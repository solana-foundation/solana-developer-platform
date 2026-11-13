//! The postconditions of an intent, the interface's then the implementation's, with their values
//! resolved, then the standing rule of `DESIGN.md`, 4.5, rule 3: no authority of a signer input's
//! accounts changes. The planner checks them in simulation, and the Lighthouse assertions check them
//! onchain, so both read them from here.

use sdp_intents_spec::wire::PostConditionV1;
use sdp_intents_spec::{Address, CheckKind, SpecError, ValueRef, ValueSource, ValueType};

use crate::borsh::{integer_width, is_signed, value_len};
use crate::{EngineError, Recipe};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Condition {
    Outflow {
        from: Address,
        mint: Address,
        max: u128,
    },
    Inflow {
        to: Address,
        mint: Address,
        min: u128,
    },
    NoOtherOutflows {
        from: Address,
    },
    NoAuthorityChange {
        owner: Address,
    },
    /// Every top-level instruction invokes a listed program. No account state shows it.
    InvokesOnly,
    /// After the span, each of `from`'s token accounts of `mint` names `to` as its delegate, for at
    /// most `max`. It is the one authority change that rule 3 then allows on those accounts.
    Delegates {
        from: Address,
        mint: Address,
        to: Address,
        max: u128,
    },
    /// After the span, no token account of `from` of `mint` has a delegate.
    NoDelegate {
        from: Address,
        mint: Address,
    },
}

/// The document whose address table a value with source `Address` indexes.
#[derive(Clone, Copy)]
enum Table {
    Interface,
    Implementation,
}

#[derive(Clone, Copy)]
struct ConditionValues<'r, 'a> {
    recipe: &'r Recipe<'a>,
    outputs: &'r [u8],
}

impl<'a> Recipe<'a> {
    /// `outputs` holds the interface's outputs in borsh, as a builder returns them.
    pub fn conditions<'r>(
        &'r self,
        outputs: &'r [u8],
    ) -> Result<impl Iterator<Item = Result<Condition, EngineError>> + 'r, EngineError> {
        let interface = self.interface().post_conditions()?.iter().map(|check| (check, Table::Interface));
        let implementation =
            self.implementation().post_conditions()?.iter().map(|check| (check, Table::Implementation));
        let values = ConditionValues { recipe: self, outputs };
        let stated = interface.chain(implementation).map(move |(check, table)| values.condition(check, table));

        Ok(stated.chain(self.signer_authorities()?))
    }

    /// A `NoAuthorityChange` for each required signer input, whether or not a postcondition
    /// states it.
    pub fn signer_authorities<'r>(
        &'r self,
    ) -> Result<impl Iterator<Item = Result<Condition, EngineError>> + 'r, EngineError> {
        let values = ConditionValues { recipe: self, outputs: &[] };
        let signers =
            self.interface().inputs()?.iter().zip(0u8..).filter(|(input, _)| input.signer() && !input.optional());

        Ok(signers
            .map(move |(_, index)| Ok(Condition::NoAuthorityChange { owner: to_address(values.input(index)?.bytes)? })))
    }
}

impl ConditionValues<'_, '_> {
    fn condition(&self, check: &PostConditionV1, table: Table) -> Result<Condition, EngineError> {
        let [first, second, third] = check.args.map(ValueRef::try_from);
        let address = |value: Result<ValueRef, SpecError>| self.address(value?, table);

        Ok(match CheckKind::try_from(check.check)? {
            CheckKind::Outflow => {
                Condition::Outflow { from: address(first)?, mint: address(second)?, max: self.integer(third?)? }
            }
            CheckKind::Inflow => {
                Condition::Inflow { to: address(first)?, mint: address(second)?, min: self.integer(third?)? }
            }
            CheckKind::NoOtherOutflows => Condition::NoOtherOutflows { from: address(first)? },
            CheckKind::NoAuthorityChange => Condition::NoAuthorityChange { owner: address(first)? },
            CheckKind::InvokesOnly => Condition::InvokesOnly,
            CheckKind::Delegates => Condition::Delegates {
                from: address(first)?,
                mint: address(second)?,
                to: self.address(ValueRef::try_from(check.delegate())?, table)?,
                max: self.integer(third?)?,
            },
            CheckKind::NoDelegate => Condition::NoDelegate { from: address(first)?, mint: address(second)? },
        })
    }

    fn address(&self, value: ValueRef, table: Table) -> Result<Address, EngineError> {
        let recipe = self.recipe;
        let index = value.index;

        match value.source {
            ValueSource::Input => to_address(self.input(index)?.bytes),
            ValueSource::Output => to_address(self.output(index)?.bytes),
            ValueSource::Payer if index == 0 => Ok(*recipe.payers().fee),
            ValueSource::Payer => Ok(*recipe.payers().rent),
            ValueSource::Account => recipe.address(index).copied().ok_or(EngineError::Unresolved { account: index }),
            ValueSource::Address => {
                let addresses = match table {
                    Table::Interface => recipe.interface().addresses()?,
                    Table::Implementation => recipe.implementation().addresses()?,
                };

                addresses.get(usize::from(index)).copied().ok_or(EngineError::BadCondition)
            }
            ValueSource::None | ValueSource::Literal => Err(EngineError::BadCondition),
        }
    }

    /// An unsigned integer input or output.
    fn integer(&self, value: ValueRef) -> Result<u128, EngineError> {
        let typed = match value.source {
            ValueSource::Input => self.input(value.index)?,
            ValueSource::Output => self.output(value.index)?,
            _ => return Err(EngineError::BadCondition),
        };

        let width = integer_width(typed.value_type.base).ok_or(EngineError::BadCondition)?;

        if typed.value_type.array || is_signed(typed.value_type.base) || typed.bytes.len() != width {
            return Err(EngineError::BadCondition);
        }

        let mut wide = [0u8; 16];
        wide.get_mut(..width).ok_or(EngineError::BadCondition)?.copy_from_slice(typed.bytes);

        Ok(u128::from_le_bytes(wide))
    }

    /// A present input without its option tag. `Recipe::bind` checked that it holds its type.
    fn input(&self, index: u8) -> Result<TypedBytes<'_>, EngineError> {
        let inputs = self.recipe.interface().inputs()?;
        let input = inputs.get(usize::from(index)).ok_or(EngineError::BadCondition)?;
        let bytes = self.recipe.intent().input(index)?;
        let bytes = match (input.optional(), bytes.split_first()) {
            (false, _) => bytes,
            (true, Some((1, value))) => value,
            (true, _) => return Err(EngineError::BadCondition),
        };

        Ok(TypedBytes { value_type: input.value_type()?, bytes })
    }

    /// Output `index`, after the outputs before it.
    fn output(&self, index: u8) -> Result<TypedBytes<'_>, EngineError> {
        let mut rest = self.outputs;

        for (output, position) in self.recipe.interface().outputs()?.iter().zip(0u8..) {
            let value_type = output.value_type()?;
            let len = value_len(value_type, rest).ok_or(EngineError::BadCondition)?;
            let (bytes, after) = rest.split_at_checked(len).ok_or(EngineError::BadCondition)?;

            if position == index {
                return Ok(TypedBytes { value_type, bytes });
            }

            rest = after;
        }

        Err(EngineError::BadCondition)
    }
}

struct TypedBytes<'b> {
    value_type: ValueType,
    bytes: &'b [u8],
}

fn to_address(bytes: &[u8]) -> Result<Address, EngineError> {
    bytes.try_into().map(Address).map_err(|_| EngineError::BadCondition)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;

    /// The interface's postconditions, then rule 3 for the signer input `from`.
    #[test]
    fn resolves_the_interface_conditions_of_a_transfer() {
        let compiled = Compiled::compile(SYSTEM_TRANSFER, INTENT_SYSTEM_TRANSFER);
        let recipe = compiled.recipe().unwrap();

        let conditions: Vec<_> = recipe.conditions(&[]).unwrap().collect::<Result<_, _>>().unwrap();

        assert_eq!(
            conditions,
            [
                Condition::Outflow { from: address(FROM), mint: Address::default(), max: 250_000_000 },
                Condition::NoOtherOutflows { from: address(FROM) },
                Condition::NoAuthorityChange { owner: address(FROM) },
            ]
        );
    }
}
