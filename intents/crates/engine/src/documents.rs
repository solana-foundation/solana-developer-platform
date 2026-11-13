use sdp_intents_spec::wire::{AppliesV1, SegmentV1};
use sdp_intents_spec::{
    AddressSource, AppliesKind, Implementation, Intent, Interface, RecipeKind, Segment, ValueRef, ValueSource,
};

use crate::borsh::is_value;
use crate::{EngineError, Payers};

/// The documents of one intent, after the checks that need no account data.
#[derive(Clone, Copy)]
pub(crate) struct Documents<'a> {
    pub(crate) interface: Interface<'a>,
    pub(crate) implementation: Implementation<'a>,
    pub(crate) intent: Intent<'a>,
    pub(crate) payers: Payers<'a>,
}

impl<'a> Documents<'a> {
    /// The checks of `Recipe::bind`.
    pub(crate) fn bind(
        interface: Interface<'a>,
        implementation: Implementation<'a>,
        intent: Intent<'a>,
        payers: Payers<'a>,
    ) -> Result<Self, EngineError> {
        let documents = Self { interface, implementation, intent, payers };

        if intent.interface() != interface.id() || intent.implementation() != implementation.id() {
            return Err(EngineError::WrongDocument);
        }

        documents.check_implements()?;
        documents.check_inputs()?;
        documents
            .implementation
            .applies()?
            .iter()
            .zip(0u8..)
            .try_for_each(|(applies, index)| documents.check_applies(applies, index))?;

        Ok(documents)
    }

    /// The accounts of the implementation that are program addresses, PDAs and ATAs, in implementation order.
    pub(crate) fn program_addresses(&self) -> Result<crate::resolve::AccountSet, EngineError> {
        let accounts = self.implementation.accounts()?;

        accounts.iter().zip(0u8..).try_fold(crate::resolve::AccountSet::default(), |mut set, (account, index)| {
            if matches!(account.address()?, AddressSource::Pda { .. } | AddressSource::Ata { .. }) {
                set.insert(index);
            }

            Ok(set)
        })
    }

    fn check_implements(&self) -> Result<(), EngineError> {
        let implements = self.implementation.implements();
        let interface = self.interface.id();
        let lowest = (implements.version.minor.get(), implements.version.patch.get());
        let defined = (interface.version.minor.get(), interface.version.patch.get());

        let same_interface = implements.publisher == interface.publisher && implements.name_hash == interface.name_hash;
        let covered = implements.version.major == interface.version.major && lowest <= defined;

        if !same_interface || !covered {
            return Err(EngineError::WrongInterface);
        }

        Ok(())
    }

    fn check_inputs(&self) -> Result<(), EngineError> {
        let inputs = self.interface.inputs()?;

        if self.intent.inputs()?.len() != inputs.len() {
            return Err(EngineError::WrongDocument);
        }

        let used = self.used_inputs()?;

        inputs.iter().zip(0u8..).try_for_each(|(input, index)| {
            let bytes = self.intent.input(index)?;

            if !is_value(input.value_type()?, input.optional(), bytes) {
                return Err(EngineError::BadInput { input: index });
            }

            let present = !input.optional() || bytes.first() == Some(&1);

            if present && input.optional() && !used.contains(index) {
                return Err(EngineError::UnusedInput { input: index });
            }

            Ok(())
        })
    }

    fn check_applies(&self, applies: &AppliesV1, index: u8) -> Result<(), EngineError> {
        let value = ValueRef::try_from(applies.value)?;
        let optional = |input: u8| -> Result<bool, EngineError> {
            let inputs = self.interface.inputs()?;

            Ok(inputs.get(usize::from(input)).ok_or(EngineError::BadInput { input })?.optional())
        };

        let holds = match AppliesKind::try_from(applies.kind)? {
            // An owner hint needs account data, so `Recipe::resolve` checks it.
            AppliesKind::Owner => true,
            AppliesKind::InputPresent => !optional(value.index)? || self.intent.input(value.index)?.first() == Some(&1),
            AppliesKind::InputAbsent => optional(value.index)? && self.intent.input(value.index)? == [0],
            AppliesKind::InputEquals => {
                let expected = self.implementation.addresses()?.get(usize::from(applies.owner));
                let bytes = self.intent.input(value.index)?;
                let value = if optional(value.index)? { bytes.strip_prefix(&[1]) } else { Some(bytes) };

                expected.is_some_and(|expected| value == Some(&expected.0[..]))
            }
        };

        if !holds {
            return Err(EngineError::AppliesFailed { applies: index });
        }

        Ok(())
    }

    /// The inputs that an account source, a seed, or a data segment of the recipe reads.
    fn used_inputs(&self) -> Result<InputSet, EngineError> {
        let mut used = InputSet::default();

        if matches!(self.implementation.recipe()?, RecipeKind::Remote | RecipeKind::RemoteTransaction) {
            return Ok(InputSet::ALL);
        }

        for account in self.implementation.accounts()? {
            match account.address()? {
                AddressSource::Value(value) => used.add(value),
                AddressSource::Pda { program, seeds } => {
                    used.add(program);
                    self.implementation.seeds(seeds)?.iter().try_for_each(|seed| used.add_segment(seed))?;
                }
                AddressSource::Ata { owner, mint, token_program } => {
                    [owner, mint, token_program].into_iter().for_each(|value| used.add(value))
                }
                AddressSource::Static { .. } | AddressSource::HasOne { .. } => {}
            }
        }

        for instruction in self.implementation.instructions()? {
            self.implementation
                .instruction_segments(instruction)?
                .iter()
                .try_for_each(|segment| used.add_segment(segment))?;
        }

        Ok(used)
    }
}

/// A set of input indexes. An interface has at most 16 inputs.
#[derive(Clone, Copy, Default)]
struct InputSet(u16);

impl InputSet {
    /// A remote endpoint receives every input.
    const ALL: Self = Self(u16::MAX);

    fn add(&mut self, value: ValueRef) {
        if value.source == ValueSource::Input {
            self.0 |= 1u16.checked_shl(u32::from(value.index)).unwrap_or(0);
        }
    }

    fn add_segment(&mut self, segment: &SegmentV1) -> Result<(), EngineError> {
        if let Segment::Reference { value, .. } = segment.decode()? {
            self.add(value);
        }

        Ok(())
    }

    fn contains(self, index: u8) -> bool {
        self.0 & 1u16.checked_shl(u32::from(index)).unwrap_or(0) != 0
    }
}

#[cfg(test)]
mod tests {
    use sdp_intents_spec::{Address, Implementation, Intent, Interface};

    use super::*;
    use crate::test_support::*;

    fn edit(text: &str, from: &str, to: &str) -> String {
        assert_eq!(text.matches(from).count(), 1, "`{from}` must occur once");

        text.replace(from, to)
    }

    #[test]
    fn binds_each_example() {
        assert!(Compiled::compile(SYSTEM_TRANSFER, INTENT_SYSTEM_TRANSFER).recipe().is_ok());
        assert!(Compiled::compile(SPL_TOKEN_TRANSFER, INTENT_SPL_TRANSFER).recipe().is_ok());
        assert!(Compiled::compile(TOKEN_2022_TRANSFER, INTENT_TOKEN_2022_TRANSFER).recipe().is_ok());
    }

    #[test]
    fn refuses_a_memo_that_the_recipe_does_not_read() {
        let intent = edit(INTENT_SPL_TRANSFER, r#""memo": null"#, r#""memo": "invoice 7""#);

        assert_eq!(
            Compiled::compile(SPL_TOKEN_TRANSFER, &intent).recipe().err(),
            Some(EngineError::UnusedInput { input: 4 })
        );
    }

    #[test]
    fn a_memo_that_the_builder_reads_is_allowed() {
        let intent = edit(INTENT_TOKEN_2022_TRANSFER, r#""memo": null"#, r#""memo": "invoice 7""#);

        assert!(Compiled::compile(TOKEN_2022_TRANSFER, &intent).recipe().is_ok());
    }

    #[test]
    fn refuses_a_sol_transfer_of_another_mint() {
        let intent = edit(INTENT_SYSTEM_TRANSFER, "\"11111111111111111111111111111111\"", &format!("\"{USDC}\""));

        assert_eq!(
            Compiled::compile(SYSTEM_TRANSFER, &intent).recipe().err(),
            Some(EngineError::AppliesFailed { applies: 0 })
        );
    }

    #[test]
    fn refuses_an_intent_for_another_implementation() {
        let spl = Compiled::compile(SPL_TOKEN_TRANSFER, INTENT_SPL_TRANSFER);
        let system = Compiled::compile(SYSTEM_TRANSFER, INTENT_SYSTEM_TRANSFER);

        let bound = crate::Recipe::bind(
            Interface::parse(&spl.interface).unwrap(),
            Implementation::parse(&system.implementation).unwrap(),
            Intent::parse(&spl.intent).unwrap(),
            Payers { fee: &Address([1; 32]), rent: &Address([1; 32]) },
        );

        assert_eq!(bound.err(), Some(EngineError::WrongDocument));
    }
}
