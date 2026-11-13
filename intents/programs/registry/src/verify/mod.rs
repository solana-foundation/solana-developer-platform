//! `verify_intent`: proves in the transaction that its segment is what the implementation builds for the
//! intent, guarded by the assertions of its postconditions, so a signer needs only the transaction
//! bytes. [`position`] gives where the segment is.
//!
//! The accounts are the instructions sysvar, the fee payer, the rent payer, the two indexes, the
//! two version accounts, every account of the implementation's account table in order, for a program
//! recipe the accounts of the builder's last `MoreAccounts` round, then the guarded accounts.
//!
//! The data is the intent in binary form, the builder's role of each account of its instructions
//! for a program recipe, the interface's outputs, the bump of each program address of the implementation,
//! the bumps of a builder's program addresses, and the [`SegmentLayout`]. A static recipe holds
//! no roles, because `verify_intent` builds its instructions itself. A remote recipe holds the roles
//! that its endpoint stated, and [`remote_recipe`] checks what holds for any instructions.
//!
//! The outputs and the counts of the layout are what a signer reads to render the message and to
//! find the segment, so `verify_intent` refuses any that differ from what it derives.

mod assertions;
mod chain;
mod position;
mod program_recipe;
mod registry;
mod remote_recipe;
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
    /// The interface's outputs, in borsh.
    pub outputs: &'a [u8],
    /// The canonical bump of each program address of the implementation, in implementation order, so that each
    /// derives with one hash. The signer's verifier checks offchain that each bump is canonical.
    pub bumps: &'a [u8],
    /// The canonical bumps of a builder's program addresses, which `verify_intent` passes to the
    /// builder as `{builder.bumps}`. The builder refuses any bump that is not canonical.
    pub builder_bumps: &'a [u8],
    pub layout: SegmentLayout,
}

/// The rent cap, and the counts of the accounts and the instructions of the segment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, AnchorSerialize, AnchorDeserialize, IdlType)]
pub struct SegmentLayout {
    /// The most that the rent payer spends on new accounts in the segment.
    pub rent_cap: u64,
    /// The guarded accounts, which end the accounts of the instruction.
    pub guarded_accounts: u8,
    pub snapshots: u8,
    pub built: u8,
    /// The assertions and the close of memory.
    pub checks: u8,
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

    let mut recipe = Recipe::parse_published(interface, implementation, args.intent, payers).map_err(refused)?;
    recipe.state_bumps(args.bumps).map_err(refused)?;
    recipe.state_builder_bumps(args.builder_bumps).map_err(refused)?;
    registry::check_indexes(accounts, &recipe)?;

    let layout = args.layout;
    let implementation_len = passed.len().checked_sub(usize::from(layout.guarded_accounts));
    let (implementation, guarded) = passed.split_at(implementation_len.ok_or(RegistryError::WrongGuardedAccounts)?);
    let chain = PassedAccounts::borrow(implementation)?;
    resolve(&mut recipe, &chain)?;

    let first = position::first_after(sysvar)?;
    let snapshots = position::span(sysvar, first, usize::from(layout.snapshots))?;
    let ends = SegmentEnds { options, recipe: &recipe, guarded, layout, snapshots };

    match recipe.implementation().recipe().map_err(|error| refused(error.into()))? {
        RecipeKind::Static => {
            require!(args.builder_roles.is_empty(), RegistryError::WrongBuilderRoles);

            require!(static_recipe::outputs(&recipe)? == args.outputs, RegistryError::WrongOutputs);

            let built = ends.built(sysvar, static_recipe::count(&recipe)?)?;
            let compared = static_recipe::compare(&recipe, &chain, sysvar, &built)?;
            let end = ends.end(sysvar, compared.named.clone(), args.outputs, &built)?;

            static_recipe::check_roles(&compared, sysvar, &Segment { built, whole: first..end })
        }
        RecipeKind::Program => {
            let hashed = program_recipe::call(&recipe, &chain)?;
            require!(hashed.outputs == args.outputs, RegistryError::WrongOutputs);

            let built = ends.built(sysvar, hashed.num_instructions)?;
            let named = position::named(sysvar, &built, builder_roles(args.builder_roles)?.into_iter())?;
            let end = ends.end(sysvar, named, args.outputs, &built)?;

            program_recipe::verify(&hashed, sysvar, payers, args.builder_roles, &Segment { built, whole: first..end })
        }
        RecipeKind::Remote => {
            require!(options.assertions, RegistryError::RemoteNeedsAssertions);
            remote_recipe::check_outputs(&recipe, args.outputs)?;

            let built = ends.built(sysvar, usize::from(layout.built))?;
            remote_recipe::check_programs(&recipe, sysvar, &built)?;

            let named = position::named(sysvar, &built, builder_roles(args.builder_roles)?.into_iter())?;
            require!(named.len() == args.builder_roles.len(), RegistryError::WrongBuilderRoles);

            let mut roles = roles::TransactionRoles::new(payers.fee);
            named.iter().for_each(|meta| roles.add(&meta.address, meta.role));
            let end = ends.end(sysvar, named, args.outputs, &built)?;

            program_recipe::check_roles(sysvar, &Segment { built, whole: first..end }, &roles)
        }
        RecipeKind::RemoteTransaction => Err(RegistryError::WrongRecipeKind.into()),
    }
}

/// What the end of a segment depends on besides its built instructions.
struct SegmentEnds<'v, 'a> {
    options: IntentOptions,
    recipe: &'v Recipe<'a>,
    guarded: &'v [AccountView],
    layout: SegmentLayout,
    snapshots: Range<usize>,
}

impl SegmentEnds<'_, '_> {
    /// The built span after the snapshots. `len` comes from the implementation or the builder, and the
    /// layout must state it.
    fn built(&self, sysvar: &SysvarInstructions, len: usize) -> Result<Range<usize>> {
        require!(usize::from(self.layout.built) == len, RegistryError::WrongSegmentLayout);

        position::span(sysvar, self.snapshots.end, len)
    }

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

            let layout = self.layout;
            require!(layout.snapshots == 0 && layout.checks == 0, RegistryError::WrongSegmentLayout);

            return Ok(built.end);
        }

        let assertions = SegmentAssertions {
            sysvar,
            recipe: self.recipe,
            outputs,
            named,
            guarded: self.guarded,
            rent_cap: self.layout.rent_cap,
            snapshots: self.snapshots.clone(),
            built,
        };
        let end = assertions.verify()?;
        let checks = end.checked_sub(built.end).ok_or(ProgramError::ArithmeticOverflow)?;
        require!(usize::from(self.layout.checks) == checks, RegistryError::WrongSegmentLayout);

        Ok(end)
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
/// must be the account at its place in the implementation's table.
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
