//! `verify_intent`: proves in the transaction that its instructions are what the record builds for
//! the intent, so a signer needs only the transaction bytes. The data is the intent in binary form.
//!
//! The accounts are the instructions sysvar, the two indexes, the two version accounts, then every
//! account of the record's account table in order, then for a program recipe the accounts of the
//! builder's last `MoreAccounts` round. [`position`] gives where the checked instructions are.
//!
//! For a program recipe, the data also holds the builder's role of each account of its
//! instructions, one byte each, in order. A static recipe holds none, because `verify_intent`
//! builds those instructions itself.

mod chain;
mod position;
mod program_recipe;
mod registry;
mod roles;
mod static_recipe;

use anchor_lang::prelude::*;
use sdp_intents_engine::{EngineError, Recipe, Resolution};
use sdp_intents_spec::wire::DocumentKind;
use sdp_intents_spec::{Intent, RecipeKind};

use crate::error::RegistryError;
use crate::state::version;
use chain::PassedAccounts;

#[derive(Accounts)]
pub struct VerifyIntent {
    pub instructions: Sysvar<SysvarInstructions>,
    pub interface_index: UncheckedAccount,
    pub implementation_index: UncheckedAccount,
    pub interface_version: UncheckedAccount,
    pub implementation_version: UncheckedAccount,
}

pub fn verify_intent(
    accounts: &VerifyIntent,
    record_accounts: &[AccountView],
    intent: &[u8],
    builder_roles: &[u8],
) -> Result<()> {
    let built = position::built_instructions(&accounts.instructions)?;
    check_options(intent)?;

    let interface_data = version::load(accounts.interface_version.account(), DocumentKind::Interface)?;
    let implementation_data = version::load(accounts.implementation_version.account(), DocumentKind::Implementation)?;
    let interface = version::document(&interface_data)?;
    let implementation = version::document(&implementation_data)?;

    let mut recipe = Recipe::parse(interface, implementation, intent).map_err(refused)?;
    registry::check_indexes(accounts, &recipe)?;

    let chain = PassedAccounts::borrow(record_accounts)?;
    resolve(&mut recipe, &chain)?;

    match recipe.implementation().recipe().map_err(|error| refused(error.into()))? {
        RecipeKind::Static => {
            require!(builder_roles.is_empty(), RegistryError::WrongBuilderRoles);
            static_recipe::verify(&recipe, &chain, &accounts.instructions, built)
        }
        RecipeKind::Program => program_recipe::verify(&recipe, &chain, &accounts.instructions, built, builder_roles),
        RecipeKind::Remote => Ok(()),
    }
}

/// `verify_intent` cannot check Lighthouse assertions yet, so it refuses an intent that asks for
/// them. A signer then never reads a guarantee that the transaction does not hold.
fn check_options(intent: &[u8]) -> Result<()> {
    let options = Intent::parse(intent).and_then(|intent| intent.options()).map_err(|error| refused(error.into()))?;

    require!(options.verify_intent, RegistryError::VerificationOff);
    require!(!options.assertions, RegistryError::AssertionsUnavailable);

    Ok(())
}

/// One `resolve` completes, because every account is in the instruction. Each resolved address
/// must be the account at its place in the record's table.
fn resolve(recipe: &mut Recipe<'_>, chain: &PassedAccounts<'_>) -> Result<()> {
    if let Resolution::Missing(_) = recipe.resolve(chain).map_err(refused)? {
        return Err(RegistryError::WrongRecipeAccount.into());
    }

    let table_len = recipe.implementation().accounts().map_err(|error| refused(error.into()))?.len();
    let program_recipe =
        recipe.implementation().recipe().map_err(|error| refused(error.into()))? == RecipeKind::Program;
    let passed = chain.views.len();

    require!(passed == table_len || (program_recipe && passed > table_len), RegistryError::WrongRecipeAccount);

    let matches = (0u8..)
        .zip(chain.views.iter().take(table_len))
        .all(|(account, view)| recipe.address(account).is_some_and(|address| view.address().as_ref() == address.0));

    require!(matches, RegistryError::WrongRecipeAccount);

    Ok(())
}

/// The engine's reason goes to the log, and the instruction fails with `RecipeRefused`.
pub(crate) fn refused(error: EngineError) -> anchor_lang::Error {
    msg!("verify_intent: {}", error);

    RegistryError::RecipeRefused.into()
}
