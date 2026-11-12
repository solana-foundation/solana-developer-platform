//! One intent on its way to instructions: `bind` checks the documents, `resolve` runs until the chain
//! holds every account that the recipe reads, and `instructions` builds.

use sdp_intents_spec::builder::PAYER_RENT_PLACEHOLDER;
use sdp_intents_spec::{Address, Implementation, Intent, Interface, RecipeKind};

use crate::documents::Documents;
use crate::hints::HintAccounts;
use crate::instructions::build;
use crate::resolve::{AccountSet, Addresses};
use crate::value::Context;
use crate::{BuiltInstruction, Chain, EngineError, Instructions, Payers};

/// A builder call holds at most 64 accounts, the account limit of a v1 transaction.
const MAX_BUILDER_ACCOUNTS: usize = 64;

/// The recipe of one intent, with the accounts that `resolve` has derived. It holds about 1.2 KB, so
/// a program can keep it in one stack frame.
pub struct Recipe<'a> {
    documents: Documents<'a>,
    addresses: Addresses,
    missing_hints: HintAccounts,
    complete: bool,
}

pub enum Resolution<'r> {
    /// Every address is derived, every owner hint holds, and the chain holds every account that
    /// the instructions read.
    Complete,
    /// The chain must hold these accounts before the next `resolve`.
    Missing(Missing<'r>),
}

/// The accounts that the next `resolve` needs, each address once.
pub struct Missing<'r> {
    addresses: &'r Addresses,
    accounts: AccountSet,
    hints: &'r [Address],
}

impl<'r> Missing<'r> {
    pub fn addresses(&self) -> impl Iterator<Item = &'r Address> + use<'r> {
        let addresses = self.addresses;
        let accounts = self.accounts;
        let in_accounts = move |hint: &&Address| accounts.iter().any(|account| addresses.get(account) == Some(*hint));

        accounts
            .iter()
            .filter_map(move |account| addresses.get(account))
            .chain(self.hints.iter().filter(move |hint| !in_accounts(hint)))
    }
}

impl<'a> Recipe<'a> {
    /// Checks that the intent names both documents, that the implementation implements the
    /// interface at its version, that each input holds a value of its type, and that the input
    /// checks of `applies` hold. An optional input that the recipe does not read must be absent,
    /// because a recipe that does not read an input cannot fail on it. The owner hints of
    /// `applies` need account data, so `resolve` checks them.
    pub fn bind(
        interface: Interface<'a>,
        implementation: Implementation<'a>,
        intent: Intent<'a>,
    ) -> Result<Self, EngineError> {
        Ok(Self {
            documents: Documents::bind(interface, implementation, intent)?,
            addresses: Addresses::default(),
            missing_hints: HintAccounts::default(),
            complete: false,
        })
    }

    /// Parses the three documents, then binds them.
    pub fn parse(interface: &'a [u8], implementation: &'a [u8], intent: &'a [u8]) -> Result<Self, EngineError> {
        Self::bind(Interface::parse(interface)?, Implementation::parse(implementation)?, Intent::parse(intent)?)
    }

    /// Derives every address that the chain's data allows, and checks the owner hints. `Missing`
    /// holds every account whose data the next step needs: one `hasOne` level, the resolved `read`
    /// accounts, and the hint accounts.
    ///
    /// The service fetches them in one call, with every resolved account that its cache does not
    /// hold, so the last fetch also loads the simulation. A program holds every account already, so
    /// one call completes or fails.
    pub fn resolve<C: Chain>(&mut self, chain: &C) -> Result<Resolution<'_>, EngineError> {
        let accounts = self.documents.derive_addresses(&mut self.addresses, chain)?;
        self.missing_hints = self.documents.check_hints(&self.addresses, chain)?;

        if !accounts.is_empty() || !self.missing_hints.as_slice().is_empty() {
            return Ok(Resolution::Missing(Missing {
                addresses: &self.addresses,
                accounts,
                hints: self.missing_hints.as_slice(),
            }));
        }

        if let Some(account) = self.documents.first_unresolved(&self.addresses)? {
            return Err(EngineError::Unresolved { account });
        }

        self.complete = true;

        Ok(Resolution::Complete)
    }

    /// The address of account `account` of the record. A program compares it with the account that
    /// its instruction holds at that place.
    pub fn address(&self, account: u8) -> Option<&Address> {
        self.addresses.get(account)
    }

    /// The address that a static recipe binds to output `output`. A builder returns its outputs
    /// in its result instead.
    pub fn output_address(&self, output: u8) -> Result<&Address, EngineError> {
        let bindings = self.documents.implementation.output_bindings()?;
        let binding = bindings.iter().find(|binding| binding.output == output);
        let account = binding.ok_or(EngineError::UnboundOutput { output })?.account;

        self.addresses.get(account).ok_or(EngineError::Unresolved { account })
    }

    pub fn interface(&self) -> &Interface<'a> {
        &self.documents.interface
    }

    pub fn implementation(&self) -> &Implementation<'a> {
        &self.documents.implementation
    }

    pub fn intent(&self) -> &Intent<'a> {
        &self.documents.intent
    }

    pub fn payers(&self) -> Payers<'a> {
        Payers { fee: self.documents.intent.fee_payer(), rent: self.documents.intent.rent_payer() }
    }

    /// The instructions of a static recipe.
    pub fn instructions<'r, C: Chain>(&'r self, chain: &'r C) -> Result<Instructions<'r, C>, EngineError> {
        Instructions::new(self.context(RecipeKind::Static, chain)?)
    }

    /// The builder call of a program recipe: the record's accounts, then `extra_accounts`, which
    /// the builder asked for in earlier rounds. Every extra account is readonly, and none is a
    /// payer, so the builder can change nothing.
    pub fn builder_call<'r, C: Chain>(
        &'r self,
        chain: &'r C,
        extra_accounts: &'r [Address],
    ) -> Result<BuiltInstruction<'r, C>, EngineError> {
        let context = self.context(RecipeKind::Program, chain)?;
        let call = self
            .documents
            .implementation
            .instructions()?
            .first()
            .ok_or(EngineError::WrongRecipe { expected: RecipeKind::Program })?;
        let built = build(context, call, extra_accounts)?;

        if built.accounts_len() > MAX_BUILDER_ACCOUNTS {
            return Err(EngineError::TooManyAccounts);
        }

        let payers = self.payers();
        let names_payer =
            |address: &Address| address == payers.fee || address == payers.rent || *address == PAYER_RENT_PLACEHOLDER;

        if extra_accounts.iter().any(names_payer) {
            return Err(EngineError::PayerAccount);
        }

        Ok(built)
    }

    fn context<'r, C: Chain>(&'r self, kind: RecipeKind, chain: &'r C) -> Result<Context<'r, C>, EngineError> {
        if !self.complete {
            return Err(EngineError::NotResolved);
        }

        if self.documents.implementation.recipe()? != kind {
            return Err(EngineError::WrongRecipe { expected: kind });
        }

        Ok(Context { documents: self.documents, addresses: &self.addresses, chain })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_recipe_fits_a_stack_frame() {
        assert!(core::mem::size_of::<Recipe>() <= 1_300);
    }
}
