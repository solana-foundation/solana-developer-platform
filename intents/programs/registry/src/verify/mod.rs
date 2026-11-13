//! `verify_intent`: proves in the transaction that its segment is what the record builds for the
//! intent, guarded by the assertions of its postconditions, so a signer needs only the transaction
//! bytes. [`position`] gives where the segment is.
//!
//! The accounts are the instructions sysvar, the fee payer, the rent payer, the two indexes, the
//! two version accounts, every account of the record's account table in order, for a program
//! recipe the accounts of the builder's last `MoreAccounts` round, then the guarded accounts.
//!
//! The data is the intent in binary form, the builder's role of each account of its instructions
//! for a program recipe, the rent cap, and the count of guarded accounts. A static recipe holds no
//! roles, because `verify_intent` builds its instructions itself. A remote recipe's span is empty,
//! so `verify_intent` proves only the record and its accounts.

mod assertions;
mod chain;
mod position;
mod program_recipe;
mod registry;
mod roles;
mod static_recipe;

use alloc::vec::Vec;
use core::ops::Range;

use anchor_lang::prelude::*;
use sdp_intents_engine::{EngineError, Payers, Recipe, Resolution};
use sdp_intents_spec::wire::DocumentKind;
use sdp_intents_spec::{AccountRole, Intent, IntentOptions, RecipeKind};

use crate::error::RegistryError;
use crate::state::{spec_address, version};
use assertions::SegmentAssertions;
use chain::PassedAccounts;
use position::Segment;

#[derive(Accounts)]
pub struct VerifyIntent {
    pub instructions: Sysvar<SysvarInstructions>,
    pub fee_payer: UncheckedAccount,
    pub rent_payer: UncheckedAccount,
    pub interface_index: UncheckedAccount,
    pub implementation_index: UncheckedAccount,
    pub interface_version: UncheckedAccount,
    pub implementation_version: UncheckedAccount,
}

/// The instruction's arguments.
pub struct VerifyArgs<'a> {
    pub intent: &'a [u8],
    pub builder_roles: &'a [u8],
    /// The most that the rent payer spends on new accounts in the segment.
    pub rent_cap: u64,
    /// The count of guarded accounts, which end the accounts of the instruction.
    pub guarded_accounts: u8,
}

pub fn verify_intent(accounts: &VerifyIntent, passed: &[AccountView], args: VerifyArgs<'_>) -> Result<()> {
    let sysvar = &accounts.instructions;
    position::check_top_level(sysvar)?;
    let options = check_options(args.intent)?;

    let interface_data = version::load(accounts.interface_version.account(), DocumentKind::Interface)?;
    let implementation_data = version::load(accounts.implementation_version.account(), DocumentKind::Implementation)?;
    let interface = version::document(&interface_data)?;
    let implementation = version::document(&implementation_data)?;

    let fee_payer = fee_payer(accounts)?;
    let rent_payer = spec_address(accounts.rent_payer.address());
    let payers = Payers { fee: &fee_payer, rent: &rent_payer };

    let mut recipe = Recipe::parse(interface, implementation, args.intent, payers).map_err(refused)?;
    registry::check_indexes(accounts, &recipe)?;

    let record_len = passed.len().checked_sub(usize::from(args.guarded_accounts));
    let (record, guarded) = passed.split_at(record_len.ok_or(RegistryError::WrongGuardedAccounts)?);
    let chain = PassedAccounts::borrow(record)?;
    resolve(&mut recipe, &chain)?;

    let first = position::first_after(sysvar)?;
    let snapshot_count = if options.assertions { position::lighthouse_run(sysvar, first) } else { 0 };
    let snapshots = first..first.checked_add(snapshot_count).ok_or(ProgramError::ArithmeticOverflow)?;
    let ends = SegmentEnds { options, recipe: &recipe, guarded, rent_cap: args.rent_cap, snapshots };

    match recipe.implementation().recipe().map_err(|error| refused(error.into()))? {
        RecipeKind::Static => {
            require!(args.builder_roles.is_empty(), RegistryError::WrongBuilderRoles);

            let built = position::span(sysvar, ends.snapshots.end, static_recipe::count(&recipe)?)?;
            let named = static_recipe::named(&recipe, &chain)?;
            let end = ends.end(sysvar, named, &static_recipe::outputs(&recipe)?, &built)?;

            static_recipe::verify(&recipe, &chain, sysvar, &Segment { built, whole: first..end })
        }
        RecipeKind::Program => {
            let hashed = program_recipe::call(&recipe, &chain)?;
            let built = position::span(sysvar, ends.snapshots.end, hashed.num_instructions)?;
            let named = position::named(sysvar, &built, builder_roles(args.builder_roles)?.into_iter())?;
            let end = ends.end(sysvar, named, &hashed.outputs, &built)?;

            program_recipe::verify(&hashed, sysvar, payers, args.builder_roles, &Segment { built, whole: first..end })
        }
        RecipeKind::Remote => Ok(()),
    }
}

/// What the end of a segment depends on besides its built instructions.
struct SegmentEnds<'v, 'a> {
    options: IntentOptions,
    recipe: &'v Recipe<'a>,
    guarded: &'v [AccountView],
    rent_cap: u64,
    snapshots: Range<usize>,
}

impl SegmentEnds<'_, '_> {
    /// The position after the segment: after the assertions, or after the built instructions when
    /// the intent turns assertions off.
    fn end(
        &self,
        sysvar: &SysvarInstructions,
        named: Vec<sdp_intents_lighthouse::Meta>,
        outputs: &[u8],
        built: &Range<usize>,
    ) -> Result<usize> {
        if !self.options.assertions {
            require!(self.guarded.is_empty(), RegistryError::WrongGuardedAccounts);
            return Ok(built.end);
        }

        let assertions = SegmentAssertions {
            sysvar,
            recipe: self.recipe,
            outputs,
            named,
            guarded: self.guarded,
            rent_cap: self.rent_cap,
            snapshots: self.snapshots.clone(),
            built,
        };

        assertions.verify()
    }
}

fn builder_roles(roles: &[u8]) -> Result<Vec<AccountRole>> {
    roles.iter().map(|role| AccountRole::try_from(*role).map_err(|_| RegistryError::WrongBuilderRoles.into())).collect()
}

/// The role check lets the fee payer be a writable signer. Only a writable signer can be the fee
/// payer, so any other account fails.
fn fee_payer(accounts: &VerifyIntent) -> Result<sdp_intents_spec::Address> {
    let fee_payer = accounts.fee_payer.account();
    require!(fee_payer.is_signer() && fee_payer.is_writable(), RegistryError::FeePayerNotSigner);

    Ok(spec_address(fee_payer.address()))
}

fn check_options(intent: &[u8]) -> Result<IntentOptions> {
    let options = Intent::parse(intent).and_then(|intent| intent.options()).map_err(|error| refused(error.into()))?;
    require!(options.verify_intent, RegistryError::VerificationOff);

    Ok(options)
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
