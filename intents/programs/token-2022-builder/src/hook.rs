//! Resolves the extra accounts of a transfer hook, as Token-2022 resolves them when it calls the
//! hook. A meta can name the key of an earlier account, which the builder already knows, or bytes in
//! the data of an earlier account. For data, the builder asks for that account with `MoreAccounts`,
//! and the next round reads it. So a hook takes one round for its meta list, and one more round for
//! each level of data that its metas read from other extra accounts.
//!
//! Each round resolves the metas again from the start. Resolution depends only on chain state, so
//! every round asks for the same accounts in the same order, as `require_accounts` needs.

use alloc::vec::Vec;

use pinocchio::account::{AccountView, Ref};
use pinocchio::address::Address;
use sdp_intents_builder::{Build, BuildError, Meta};

use crate::extra_metas::{
    extra_account_metas, AddressConfig, ExtraAccountMetaV1, PdaProgram, Seed, EXECUTE_DISCRIMINATOR,
    EXTRA_ACCOUNT_METAS_SEED,
};
use crate::preconditions::TransferAccounts;
use crate::refusal::{Refusal, Stop};

/// The source, the mint, the destination, the authority, and the meta list come before the extra
/// accounts of `Execute`.
const EXECUTE_BASE_ACCOUNTS: usize = 5;

/// An account of the hook's `Execute`, in the order that a meta's index counts.
struct ExecuteAccount<'v> {
    address: Address,
    writable: bool,
    /// The account when the builder has it, so its data can be read. Extra accounts that no meta
    /// reads the data of are never passed.
    view: Option<&'v AccountView>,
}

enum Resolution {
    Address(Address),
    /// The meta reads the data of these accounts, which the builder does not have yet.
    NeedsData(Vec<usize>),
}

/// How far one builder round gets through the metas.
enum Progress {
    Resolved,
    AskedForAccounts,
}

struct Resolver<'p, 'v> {
    program: &'p Address,
    instruction_data: Vec<u8>,
    accounts: Vec<ExecuteAccount<'v>>,
}

/// The accounts that `transferChecked` adds after its own for the hook: the extra accounts, the
/// hook program, and the meta list. `None` means that the builder asked for accounts.
pub fn hook_accounts<'a: 'v, 'v>(
    build: &mut Build<'a>,
    accounts: &TransferAccounts<'v>,
    program: &Address,
    amount: u64,
) -> Result<Option<Vec<Meta>>, Stop> {
    let seeds: [&[u8]; 2] = [EXTRA_ACCOUNT_METAS_SEED, accounts.mint.address().as_ref()];
    let (meta_list_address, _) = Address::try_find_program_address(&seeds, program).ok_or(Refusal::HookUnresolvable)?;

    let Some(given) = build.require_accounts(&[meta_list_address])? else {
        return Ok(None);
    };

    let meta_list = given.first().ok_or(BuildError::WrongAccounts)?;

    if !meta_list.owned_by(program) {
        return Err(Refusal::HookUnresolvable.into());
    }

    let meta_list_data = meta_list.try_borrow()?;
    let metas = extra_account_metas(&meta_list_data)?;
    let base = [accounts.source, accounts.mint, accounts.destination, accounts.from, meta_list];
    let mut resolver = Resolver {
        program,
        instruction_data: [&EXECUTE_DISCRIMINATOR[..], &amount.to_le_bytes()].concat(),
        accounts: base
            .into_iter()
            .map(|view| ExecuteAccount { address: *view.address(), writable: false, view: Some(view) })
            .collect(),
    };

    if let Progress::AskedForAccounts = resolver.resolve_all(build, metas)? {
        return Ok(None);
    }

    let extras = resolver.accounts.get(EXECUTE_BASE_ACCOUNTS..).unwrap_or_default();
    let hook_accounts = [Meta::readonly(program), Meta::readonly(&meta_list_address)];

    Ok(Some(
        extras
            .iter()
            .map(|account| Meta::new(&account.address, false, account.writable))
            .chain(hook_accounts)
            .collect(),
    ))
}

impl<'v> Resolver<'_, 'v> {
    fn resolve_all<'a: 'v>(&mut self, build: &mut Build<'a>, metas: &[ExtraAccountMetaV1]) -> Result<Progress, Stop> {
        let mut unresolved = metas.iter().peekable();

        while let Some(meta) = unresolved.peek() {
            match self.resolve(meta)? {
                Resolution::Address(address) => {
                    self.push(meta, address);
                    unresolved.next();
                }
                Resolution::NeedsData(indexes) => {
                    let addresses: Vec<Address> = indexes
                        .iter()
                        .filter_map(|index| self.accounts.get(*index))
                        .map(|account| account.address)
                        .collect();

                    let Some(views) = build.require_accounts(&addresses)? else {
                        return Ok(Progress::AskedForAccounts);
                    };

                    indexes.iter().zip(views).for_each(|(index, view)| self.attach(*index, view));
                }
            }
        }

        Ok(Progress::Resolved)
    }

    fn resolve(&self, meta: &ExtraAccountMetaV1) -> Result<Resolution, Stop> {
        match meta.address_config()? {
            AddressConfig::Fixed(address) => Ok(Resolution::Address(address)),
            AddressConfig::Pda { program, seeds } => self.pda(program, &seeds),
            AddressConfig::InAccountData { account_index, data_index } => {
                self.address_in_account_data(account_index, data_index)
            }
            AddressConfig::InInstructionData { index } => {
                let bytes = self.instruction_data.get(usize::from(index)..).and_then(|rest| rest.first_chunk::<32>());

                Ok(Resolution::Address(Address::new_from_array(*bytes.ok_or(Refusal::HookUnresolvable)?)))
            }
        }
    }

    fn pda(&self, program: PdaProgram, seeds: &[Seed<'_>]) -> Result<Resolution, Stop> {
        let program = match program {
            PdaProgram::Hook => self.program,
            PdaProgram::AtAccount(index) => &self.account(index)?.address,
        };

        let missing = self.missing_data(seeds)?;

        if !missing.is_empty() {
            return Ok(Resolution::NeedsData(missing));
        }

        let data: Vec<Option<Ref<'_, [u8]>>> =
            seeds.iter().map(|seed| self.seed_data(seed)).collect::<Result<_, _>>()?;
        let bytes: Vec<&[u8]> = seeds
            .iter()
            .zip(&data)
            .map(|(seed, data)| self.seed_bytes(seed, data.as_deref()))
            .collect::<Result<_, _>>()?;

        let (address, _) = Address::try_find_program_address(&bytes, program).ok_or(Refusal::HookUnresolvable)?;

        Ok(Resolution::Address(address))
    }

    /// The accounts whose data the seeds read and the builder does not have, each once.
    fn missing_data(&self, seeds: &[Seed<'_>]) -> Result<Vec<usize>, Refusal> {
        seeds.iter().try_fold(Vec::new(), |mut missing, seed| {
            if let Seed::AccountData { account_index, .. } = seed {
                let index = usize::from(*account_index);

                if self.account(*account_index)?.view.is_none() && !missing.contains(&index) {
                    missing.push(index);
                }
            }

            Ok(missing)
        })
    }

    fn seed_data(&self, seed: &Seed<'_>) -> Result<Option<Ref<'v, [u8]>>, Stop> {
        let Seed::AccountData { account_index, .. } = seed else {
            return Ok(None);
        };

        let view = self.account(*account_index)?.view.ok_or(Refusal::HookUnresolvable)?;

        Ok(Some(view.try_borrow()?))
    }

    fn seed_bytes<'s>(&'s self, seed: &Seed<'s>, data: Option<&'s [u8]>) -> Result<&'s [u8], Refusal> {
        let bytes = match *seed {
            Seed::Literal(bytes) => Some(bytes),
            Seed::InstructionData { index, length } => self.instruction_data.get(range(index, length)),
            Seed::AccountKey { index } => Some(self.account(index)?.address.as_ref()),
            Seed::AccountData { data_index, length, .. } => data.and_then(|data| data.get(range(data_index, length))),
        };

        bytes.ok_or(Refusal::HookUnresolvable)
    }

    fn address_in_account_data(&self, account_index: u8, data_index: u8) -> Result<Resolution, Stop> {
        let Some(view) = self.account(account_index)?.view else {
            return Ok(Resolution::NeedsData([usize::from(account_index)].into()));
        };

        let data = view.try_borrow()?;
        let bytes = data.get(usize::from(data_index)..).and_then(|rest| rest.first_chunk::<32>());

        Ok(Resolution::Address(Address::new_from_array(*bytes.ok_or(Refusal::HookUnresolvable)?)))
    }

    fn account(&self, index: u8) -> Result<&ExecuteAccount<'v>, Refusal> {
        self.accounts.get(usize::from(index)).ok_or(Refusal::HookUnresolvable)
    }

    /// Token-2022 passes no extra account as a signer, and passes one readonly when an earlier
    /// account of `Execute` with the same address is readonly.
    fn push(&mut self, meta: &ExtraAccountMetaV1, address: Address) {
        let mut same_address = self.accounts.iter().filter(|account| account.address == address).peekable();
        let demoted = same_address.peek().is_some() && !same_address.any(|account| account.writable);

        self.accounts.push(ExecuteAccount { address, writable: meta.is_writable != 0 && !demoted, view: None });
    }

    fn attach(&mut self, index: usize, view: &'v AccountView) {
        if let Some(account) = self.accounts.get_mut(index) {
            account.view = Some(view);
        }
    }
}

fn range(start: u8, length: u8) -> core::ops::Range<usize> {
    let start = usize::from(start);

    start..start.saturating_add(usize::from(length))
}
