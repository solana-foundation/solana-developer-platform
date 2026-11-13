//! Checks the owner hints of `applies`: the account that a hint names is owned by the program it
//! names, and its data starts with the discriminator. A hint selects the record, and an intent that
//! breaks it is refused before any simulation.

use sdp_intents_spec::wire::AppliesV1;
use sdp_intents_spec::{Address, AppliesKind, ValueRef};

use crate::documents::Documents;
use crate::resolve::Addresses;
use crate::value::Context;
use crate::{Chain, EngineError};

/// A record has at most 4 `applies` checks.
const MAX_HINTS: usize = 4;

/// The hint accounts whose data the chain does not hold yet.
#[derive(Default)]
pub(crate) struct HintAccounts {
    slots: [Address; MAX_HINTS],
    len: usize,
}

impl HintAccounts {
    pub(crate) fn as_slice(&self) -> &[Address] {
        self.slots.get(..self.len).unwrap_or_default()
    }

    fn push(&mut self, address: &Address) {
        if self.as_slice().contains(address) {
            return;
        }

        if let Some(slot) = self.slots.get_mut(self.len) {
            *slot = *address;
            self.len = self.len.saturating_add(1);
        }
    }
}

impl Documents<'_> {
    /// Checks each owner hint whose account the chain holds, and returns the hint accounts that it
    /// does not hold. A hint on an account that is not resolved yet waits for a later pass.
    pub(crate) fn check_hints<C: Chain>(&self, addresses: &Addresses, chain: &C) -> Result<HintAccounts, EngineError> {
        let context = Context { documents: *self, addresses, chain };
        let mut missing = HintAccounts::default();

        for (applies, index) in self.implementation.applies()?.iter().zip(0u8..) {
            if AppliesKind::try_from(applies.kind)? != AppliesKind::Owner {
                continue;
            }

            let address = match context.address(ValueRef::try_from(applies.value)?) {
                Ok(address) => address,
                Err(EngineError::Unresolved { .. }) => continue,
                Err(error) => return Err(error),
            };

            match chain.account(address) {
                Some(account) if hint_holds(&context, applies, account.owner, account.data)? => {}
                Some(_) => return Err(EngineError::AppliesFailed { applies: index }),
                None => missing.push(address),
            }
        }

        Ok(missing)
    }
}

fn hint_holds<C: Chain>(
    context: &Context<'_, C>,
    applies: &AppliesV1,
    owner: &Address,
    data: &[u8],
) -> Result<bool, EngineError> {
    let discriminator = applies.discriminator.get(..usize::from(applies.discriminator_len)).unwrap_or_default();

    Ok(owner == context.static_address(applies.owner)? && data.starts_with(discriminator))
}

#[cfg(test)]
mod tests {
    use crate::test_support::*;
    use crate::EngineError;

    #[test]
    fn a_mint_of_another_program_breaks_the_owner_hint() {
        let documents = Compiled::compile(SPL_TOKEN_TRANSFER, INTENT_SPL_TRANSFER);
        let mut recipe = documents.recipe().unwrap();
        let mut chain = MapChain::default();
        chain.insert(address(USDC), address(TOKEN_2022_PROGRAM), mint_data(6));

        assert!(recipe.resolve(&chain).is_err_and(|error| error == EngineError::AppliesFailed { applies: 0 }));
    }

    #[test]
    fn a_discriminator_must_start_the_data() {
        let hint = format!(r#"{{ "account": "{{inputs.mint}}", "owner": "{TOKEN_PROGRAM}" }}"#);
        let record = SPL_TOKEN_TRANSFER.replacen(
            &format!("\"owner\": \"{TOKEN_PROGRAM}\"\n    }}"),
            &format!("\"owner\": \"{TOKEN_PROGRAM}\", \"discriminator\": \"0a0b\"\n    }}"),
            1,
        );
        assert_ne!(record, SPL_TOKEN_TRANSFER, "the hint {hint} is in the record");

        let documents = Compiled::compile(&record, INTENT_SPL_TRANSFER);
        let mut chain = MapChain::default();
        chain.insert(address(USDC), address(TOKEN_PROGRAM), [&[0x0a, 0x0b][..], &mint_data(6)].concat());
        assert!(documents.recipe().unwrap().resolve(&chain).is_ok());

        chain.insert(address(USDC), address(TOKEN_PROGRAM), mint_data(6));
        let failed = documents.recipe().unwrap().resolve(&chain).err();
        assert_eq!(failed, Some(EngineError::AppliesFailed { applies: 0 }));
    }
}
