//! Checks that a `ValueRef` names an entry that exists.

use crate::{SpecError, ValueRef, ValueSource};

/// The table lengths that bound a `ValueRef`. An interface has no accounts. An implementation does
/// not hold its interface, so its input and output counts are `None` and its inputs and outputs
/// are checked later, against the interface.
#[derive(Clone, Copy)]
pub(crate) struct Counts {
    pub(crate) inputs: Option<usize>,
    pub(crate) outputs: Option<usize>,
    pub(crate) accounts: usize,
    pub(crate) addresses: usize,
    pub(crate) literals: usize,
    /// Whether the place can name the builder's bumps: only a program recipe's builder call can.
    pub(crate) bumps: bool,
}

impl Counts {
    pub(crate) fn check_value(self, value: ValueRef) -> Result<(), SpecError> {
        let index = usize::from(value.index);
        let below = |count: Option<usize>| count.is_none_or(|count| index < count);

        let exists = match value.source {
            ValueSource::None => index == 0,
            ValueSource::Input => below(self.inputs),
            ValueSource::Output => below(self.outputs),
            ValueSource::Payer => index <= 1,
            ValueSource::Account => index < self.accounts,
            ValueSource::Address => index < self.addresses,
            ValueSource::Literal => index < self.literals,
            ValueSource::Bumps => self.bumps && index == 0,
        };

        if !exists {
            return Err(SpecError::BadIndex);
        }

        Ok(())
    }
}

pub(crate) fn check_index(index: u8, len: usize) -> Result<(), SpecError> {
    if usize::from(index) >= len {
        return Err(SpecError::BadIndex);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts() -> Counts {
        Counts { inputs: Some(2), outputs: None, accounts: 1, addresses: 0, literals: 0, bumps: false }
    }

    #[test]
    fn checks_each_source_against_its_table() {
        let value = |source, index| ValueRef { source, index };

        assert_eq!(counts().check_value(value(ValueSource::Input, 1)), Ok(()));
        assert_eq!(counts().check_value(value(ValueSource::Input, 2)), Err(SpecError::BadIndex));
        assert_eq!(counts().check_value(value(ValueSource::Output, 9)), Ok(()));
        assert_eq!(counts().check_value(value(ValueSource::Payer, 2)), Err(SpecError::BadIndex));
        assert_eq!(counts().check_value(value(ValueSource::Address, 0)), Err(SpecError::BadIndex));
    }
}
