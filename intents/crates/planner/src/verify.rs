//! Checks the simulation of the final transaction against each postcondition and the payer rules
//! of `DESIGN.md`, section 4.5. Each check compares an account before the transaction with the
//! same account after it.

use sdp_intents_engine::{AccountData, Chain, Recipe};
use sdp_intents_spec::wire::{PostConditionV1, RangeV1};
use sdp_intents_spec::{Address, CheckKind, SpecError, ValueRef, ValueSource};

use crate::values::{Table, Values};
use crate::{Account, Instruction, PlanError};

/// `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA`.
const TOKEN_PROGRAM: Address = Address([
    6, 221, 246, 225, 215, 101, 161, 147, 217, 203, 225, 70, 206, 235, 121, 172, 28, 180, 133, 237, 95, 91, 55, 145,
    58, 140, 245, 133, 126, 255, 0, 169,
]);
/// `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb`.
const TOKEN_2022_PROGRAM: Address = Address([
    6, 221, 246, 225, 238, 117, 143, 222, 24, 66, 93, 188, 228, 108, 205, 218, 182, 26, 252, 77, 131, 185, 13, 39, 254,
    189, 249, 40, 216, 161, 139, 252,
]);
/// `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`.
const ASSOCIATED_TOKEN_PROGRAM: Address = Address([
    140, 151, 37, 143, 78, 36, 137, 241, 187, 61, 16, 41, 20, 142, 13, 131, 11, 90, 19, 153, 218, 255, 16, 132, 4, 142,
    123, 216, 219, 233, 248, 89,
]);
const TOKEN_ACCOUNT_LEN: usize = 165;
/// The rent-exempt minimum is 6,960 lamports for each byte of data and for the 128 bytes that the
/// runtime adds: 3,480 lamports a byte-year, for two years.
const RENT_LAMPORTS_PER_BYTE: u64 = 6_960;
const ACCOUNT_STORAGE_OVERHEAD: u64 = 128;

/// An ATA `Create` or `CreateIdempotent`. The ATA program uses the funder only to pay for the
/// account that it creates, so an idempotent create of an account that exists takes nothing.
fn funds_only(instruction: &Instruction) -> bool {
    instruction.program == ASSOCIATED_TOKEN_PROGRAM && matches!(instruction.data.as_slice(), [] | [0] | [1])
}

/// What the rent payer can spend on the accounts that the snapshots show as new: the rent-exempt
/// minimum of each one's data, or its lamports when they are fewer. Lamports above that minimum are
/// a transfer, not rent.
pub(crate) fn rent_cap(snapshots: &[Snapshot]) -> u64 {
    snapshots
        .iter()
        .filter(|snapshot| snapshot.before.lamports == 0 && snapshot.after.lamports > 0)
        .map(|snapshot| {
            let len = u64::try_from(snapshot.after.data.len()).unwrap_or(u64::MAX);
            let minimum = len.saturating_add(ACCOUNT_STORAGE_OVERHEAD).saturating_mul(RENT_LAMPORTS_PER_BYTE);

            snapshot.after.lamports.min(minimum)
        })
        .fold(0u64, u64::saturating_add)
}

/// An account of the transaction before and after it. An account that does not exist has no
/// lamports and no data.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Snapshot {
    pub(crate) address: Address,
    pub(crate) before: Account,
    pub(crate) after: Account,
}

/// The fields of a token account that the checks read, at the offsets of SPL Token. Token-2022
/// keeps the same offsets and puts its extensions after them.
struct TokenAccount {
    mint: Address,
    authority: Address,
    amount: u64,
    delegate: Option<Address>,
    close_authority: Option<Address>,
}

fn token_account(account: &Account) -> Option<TokenAccount> {
    if !(account.owner == TOKEN_PROGRAM || account.owner == TOKEN_2022_PROGRAM)
        || account.data.len() < TOKEN_ACCOUNT_LEN
    {
        return None;
    }

    let address = |offset: usize| account.data.get(offset..)?.first_chunk::<32>().map(|bytes| Address(*bytes));
    let optional = |tag: usize| match account.data.get(tag..)?.first_chunk::<4>()? {
        [0, 0, 0, 0] => Some(None),
        _ => address(tag.checked_add(4)?).map(Some),
    };

    Some(TokenAccount {
        mint: address(0)?,
        authority: address(32)?,
        amount: u64::from_le_bytes(*account.data.get(64..)?.first_chunk::<8>()?),
        delegate: optional(72)?,
        close_authority: optional(129)?,
    })
}

pub(crate) struct Verification<'v, 'a> {
    values: Values<'v, 'a, NoAccounts>,
    snapshots: &'v [Snapshot],
    instructions: &'v [Instruction],
    fee: u64,
}

/// Verification reads accounts from the snapshots, never through the chain. The values that it
/// reads are addresses and amounts, which need no account data.
struct NoAccounts;

impl Chain for NoAccounts {
    fn account(&self, _: &Address) -> Option<AccountData<'_>> {
        None
    }
}

/// One postcondition, with the document whose addresses and text it names.
struct Condition<'r> {
    check: &'r PostConditionV1,
    table: Table,
}

impl<'v, 'a> Verification<'v, 'a> {
    pub(crate) fn new(
        recipe: &'v Recipe<'a>,
        outputs: &'v [u8],
        snapshots: &'v [Snapshot],
        instructions: &'v [Instruction],
        fee: u64,
    ) -> Self {
        Self { values: Values { recipe, chain: &NoAccounts, outputs }, snapshots, instructions, fee }
    }

    /// `guarantees` holds the message of each postcondition, in the order of `conditions`, for the
    /// error when one does not hold.
    pub(crate) fn check(&self, guarantees: &[String]) -> Result<(), PlanError> {
        self.check_payers()?;
        self.check_signer_authorities()?;

        let conditions = self.conditions()?;

        conditions.iter().zip(guarantees).try_for_each(|(condition, guarantee)| {
            if self.holds(condition, &conditions)? {
                return Ok(());
            }

            Err(PlanError::CheckFailed(guarantee.clone()))
        })
    }

    /// The fee payer loses at most the fee and the rent of the accounts that the transaction
    /// creates, and an instruction names a payer only where it creates an account. A payer that is
    /// also a signer input can be named anywhere, because the interface requires that signer, and
    /// the postconditions guard it.
    fn check_payers(&self) -> Result<(), PlanError> {
        let payers = self.values.recipe.payers();
        let fee_payer = *payers.fee;
        let rent_payer = *payers.rent;

        if self.lamport_loss(&fee_payer) > self.payer_allowance(&fee_payer) {
            return Err(PlanError::CheckFailed(
                "the fee payer loses more than the fee and the new accounts' rent".into(),
            ));
        }

        if self.lamport_loss(&rent_payer) > self.payer_allowance(&rent_payer) {
            return Err(PlanError::CheckFailed("the rent payer loses more than the new accounts' rent".into()));
        }

        let signers = self.signer_inputs()?;
        let guarded_payers: Vec<Address> =
            [fee_payer, rent_payer].into_iter().filter(|payer| !signers.contains(payer)).collect();
        let names_payer =
            |instruction: &Instruction| instruction.accounts.iter().any(|meta| guarded_payers.contains(&meta.address));
        let creates = |instruction: &Instruction| {
            funds_only(instruction) || instruction.accounts.iter().any(|meta| self.created(&meta.address))
        };

        if self.instructions.iter().any(|instruction| names_payer(instruction) && !creates(instruction)) {
            return Err(PlanError::CheckFailed("an instruction names a payer and creates no account".into()));
        }

        Ok(())
    }

    /// The address of each signer input of the interface.
    fn signer_inputs(&self) -> Result<Vec<Address>, PlanError> {
        let inputs = self.values.recipe.interface().inputs()?;

        inputs
            .iter()
            .zip(0u8..)
            .filter(|(input, _)| input.signer())
            .map(|(_, index)| self.values.address(ValueRef { source: ValueSource::Input, index }, Table::Interface))
            .collect()
    }

    /// Rule 3 holds for every signer input, whether or not a postcondition states it: no delegate,
    /// close authority, or owner of its token accounts changes.
    fn check_signer_authorities(&self) -> Result<(), PlanError> {
        for authority in self.values.recipe.signer_authorities()? {
            if let sdp_intents_engine::Condition::NoAuthorityChange { owner } = authority? {
                if !self.no_authority_change(&owner) {
                    return Err(PlanError::CheckFailed(format!(
                        "an authority of an account of {} changes",
                        crate::render::base58(&owner)
                    )));
                }
            }
        }

        Ok(())
    }

    fn conditions(&self) -> Result<Vec<Condition<'_>>, PlanError> {
        let interface = self.values.recipe.interface().post_conditions()?.iter();
        let implementation = self.values.recipe.implementation().post_conditions()?.iter();

        Ok(interface
            .map(|check| Condition { check, table: Table::Interface })
            .chain(implementation.map(|check| Condition { check, table: Table::Implementation }))
            .collect())
    }

    fn holds(&self, condition: &Condition<'_>, all: &[Condition<'_>]) -> Result<bool, PlanError> {
        let [first, second, third] = condition.check.args.map(ValueRef::try_from);
        let address = |value: Result<ValueRef, SpecError>| self.values.address(value?, condition.table);

        match CheckKind::try_from(condition.check.check)? {
            CheckKind::Outflow => {
                let max = self.values.integer(third?)?;

                Ok(self.outflow(&address(first)?, &address(second)?) <= max)
            }
            CheckKind::Inflow => {
                let min = self.values.integer(third?)?;

                Ok(self.inflow(&address(first)?, &address(second)?) >= min)
            }
            CheckKind::NoOtherOutflows => self.no_other_outflows(&address(first)?, all),
            CheckKind::NoAuthorityChange => Ok(self.no_authority_change(&address(first)?)),
            CheckKind::InvokesOnly => self.invokes_only(condition.check.programs),
        }
    }

    /// What `from` loses of `mint`. A SOL outflow leaves out what `from` pays as a payer.
    fn outflow(&self, from: &Address, mint: &Address) -> u128 {
        if *mint == Address::default() {
            return u128::from(self.lamport_loss(from).saturating_sub(self.payer_allowance(from)));
        }

        u128::try_from(self.token_change(from, mint).saturating_neg()).unwrap_or(0)
    }

    fn inflow(&self, to: &Address, mint: &Address) -> u128 {
        if *mint == Address::default() {
            let gain = self
                .snapshot(to)
                .map_or(0, |snapshot| snapshot.after.lamports.saturating_sub(snapshot.before.lamports));

            return u128::from(gain);
        }

        u128::try_from(self.token_change(to, mint)).unwrap_or(0)
    }

    /// No balance of `from` goes down, except as an outflow postcondition or a payer role allows.
    fn no_other_outflows(&self, from: &Address, all: &[Condition<'_>]) -> Result<bool, PlanError> {
        let mut allowed_mints = Vec::new();
        let mut sol_allowed = u128::from(self.payer_allowance(from));

        for condition in all.iter().filter(|condition| condition.check.check == u8::from(CheckKind::Outflow)) {
            let [owner, mint, max] = condition.check.args.map(ValueRef::try_from);

            if self.values.address(owner?, condition.table)? != *from {
                continue;
            }

            let mint = self.values.address(mint?, condition.table)?;

            if mint == Address::default() {
                sol_allowed = sol_allowed.saturating_add(self.values.integer(max?)?);
            }

            allowed_mints.push(mint);
        }

        let lamports_hold = u128::from(self.lamport_loss(from)) <= sol_allowed;
        let tokens_hold = self
            .token_accounts_of(from)
            .filter(|mint| !allowed_mints.contains(mint))
            .all(|mint| self.token_change(from, &mint) >= 0);

        Ok(lamports_hold && tokens_hold)
    }

    /// The owner, the delegate, and the close authority of each token account of `owner` stay.
    fn no_authority_change(&self, owner: &Address) -> bool {
        self.snapshots.iter().all(|snapshot| {
            let Some(before) = token_account(&snapshot.before).filter(|account| account.authority == *owner) else {
                return true;
            };

            token_account(&snapshot.after).is_some_and(|after| {
                after.authority == before.authority
                    && after.delegate == before.delegate
                    && after.close_authority == before.close_authority
            })
        })
    }

    fn invokes_only(&self, programs: RangeV1) -> Result<bool, PlanError> {
        let addresses = self.values.recipe.implementation().addresses()?;
        let start = usize::from(programs.first);
        let allowed =
            addresses.get(start..start.saturating_add(usize::from(programs.count))).ok_or(SpecError::BadIndex)?;

        Ok(self.instructions.iter().all(|instruction| allowed.contains(&instruction.program)))
    }

    fn payer_allowance(&self, address: &Address) -> u64 {
        let payers = self.values.recipe.payers();
        let fee = if address == payers.fee { self.fee } else { 0 };
        let rent = if address == payers.rent { self.created_rent() } else { 0 };

        fee.saturating_add(rent)
    }

    fn created_rent(&self) -> u64 {
        rent_cap(self.snapshots)
    }

    fn created(&self, address: &Address) -> bool {
        self.snapshot(address).is_some_and(|snapshot| snapshot.before.lamports == 0 && snapshot.after.lamports > 0)
    }

    fn lamport_loss(&self, address: &Address) -> u64 {
        self.snapshot(address).map_or(0, |snapshot| snapshot.before.lamports.saturating_sub(snapshot.after.lamports))
    }

    /// The change in what token accounts of `authority` hold of `mint`, after less before.
    fn token_change(&self, authority: &Address, mint: &Address) -> i128 {
        let held = |account: &Account| {
            token_account(account)
                .filter(|token| token.authority == *authority && token.mint == *mint)
                .map_or(0, |token| i128::from(token.amount))
        };

        self.snapshots.iter().fold(0i128, |change, snapshot| {
            change.saturating_add(held(&snapshot.after)).saturating_sub(held(&snapshot.before))
        })
    }

    /// The mints that token accounts of `authority` hold before the transaction.
    fn token_accounts_of<'s>(&'s self, authority: &'s Address) -> impl Iterator<Item = Address> + 's {
        self.snapshots
            .iter()
            .filter_map(|snapshot| token_account(&snapshot.before))
            .filter(move |token| token.authority == *authority)
            .map(|token| token.mint)
    }

    fn snapshot(&self, address: &Address) -> Option<&Snapshot> {
        self.snapshots.iter().find(|snapshot| snapshot.address == *address)
    }
}
