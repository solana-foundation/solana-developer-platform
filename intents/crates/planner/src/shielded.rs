//! A shielded recipe's statement (`DESIGN.md`, 4.17): the notes that the spend creates, and the
//! public amounts that it deposits and withdraws. What it consumes follows from conservation.
//! Building and proving the spend needs the spender's shielded keys, so the caller builds it and
//! returns its instructions. They become the segment's built instructions, which `verify_intent`
//! limits to the pool and Lighthouse bounds by the postconditions, as for a remote recipe.

use sdp_intents_engine::{Chain, Recipe};
use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind};
use sdp_intents_spec::{AccountRole, Address, Circuit, ShieldedEntry, ShieldedProtocol};

use crate::plan::Built;
use crate::programs::{ASSOCIATED_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, TOKEN_PROGRAM};
use crate::registry::{version_address, REGISTRY_PROGRAM, VERSION_HEADER_LEN};
use crate::remote::RemoteAnswer;
use crate::{Instruction, PlanError};
use sdp_intents_registry_client::find_program_address;

const CREATE_IDEMPOTENT: u8 = 1;
/// The System program, which also names SOL in a statement.
const SYSTEM_PROGRAM: Address = Address([0; 32]);
const SOL: Address = SYSTEM_PROGRAM;

/// An entry's asset is the first 32 bytes of its data, and its amount the 8 after.
const AMOUNT_START: usize = 32;
const AMOUNT_END: usize = 40;

/// The spend that a shielded segment asks its caller to build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedCall {
    /// The privacy pool program, or the ring program that authorizes the notes.
    pub pool: Address,
    pub spend: ShieldedSpend,
    pub fee_payer: Address,
    /// Funds the token account that an SPL withdrawal creates for its recipient.
    pub rent_payer: Address,
    pub priority_fee_lamports: u64,
}

/// A note that the spend creates. The owner is a Solana address, which the registry maps to its
/// shielded address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedNote {
    pub owner: Address,
    pub asset: Address,
    pub amount: u64,
    pub data: Vec<u8>,
}

/// A public amount that the spend deposits from `account` or withdraws to it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedLeg {
    pub account: Address,
    pub asset: Address,
    pub amount: u64,
}

/// The statement that an intent of a shielded recipe requires. The spender's wallet builds a spend
/// from it, and signs only a spend that it built from the statement that the verifier reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedSpend {
    /// Which protocol's client builds the spend.
    pub protocol: ShieldedProtocol,
    /// The circuit that the spender proves with, as the registry holds it.
    pub circuit: ShieldedCircuit,
    /// The wallet whose notes the spend consumes. It signs.
    pub spender: Address,
    pub notes: Vec<ShieldedNote>,
    pub deposits: Vec<ShieldedLeg>,
    pub withdrawals: Vec<ShieldedLeg>,
}

/// A circuit document at its exact version. The spender's client refuses proving keys that it does
/// not hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShieldedCircuit {
    pub id: DocumentIdV1,
    /// The name that the id hashes, such as `privacy-rings-transact`.
    pub name: String,
    pub proving_keys: [u8; 32],
}

/// The version account of the recipe's circuit, which the planner and the verifier read.
pub(crate) fn circuit_address(recipe: &Recipe<'_>) -> Result<Address, PlanError> {
    let doc = recipe.implementation().shielded()?.ok_or(PlanError::ShieldedSpend)?;

    version_address(DocumentKind::Circuit, &doc.circuit.id)
}

/// The recipe's circuit from its version account. It must be the named version, of the recipe's
/// protocol.
fn circuit<C: Chain>(recipe: &Recipe<'_>, chain: &C, protocol: ShieldedProtocol) -> Result<ShieldedCircuit, PlanError> {
    let implementation = recipe.implementation();
    let named = implementation.shielded()?.ok_or(PlanError::ShieldedSpend)?.circuit;
    let account = chain.account(&circuit_address(recipe)?).ok_or(PlanError::Unresolved)?;
    let document = account
        .data
        .get(VERSION_HEADER_LEN..)
        .filter(|_| *account.owner == REGISTRY_PROGRAM)
        .ok_or(PlanError::ShieldedCircuit)?;
    let circuit = Circuit::parse(document).map_err(|_| PlanError::ShieldedCircuit)?;

    if *circuit.id() != named.id || circuit.protocol()? != protocol {
        return Err(PlanError::ShieldedCircuit);
    }

    let name = core::str::from_utf8(implementation.text(named.name)?).map_err(|_| PlanError::ShieldedCircuit)?;

    Ok(ShieldedCircuit { id: named.id, name: name.to_owned(), proving_keys: *circuit.proving_keys() })
}

pub(crate) fn spend<C: Chain>(recipe: &Recipe<'_>, chain: &C) -> Result<ShieldedSpend, PlanError> {
    call(recipe, chain, 0).map(|call| call.spend)
}

/// The engine resolves each entry as it resolves a static recipe's instruction.
pub(crate) fn call<C: Chain>(
    recipe: &Recipe<'_>,
    chain: &C,
    priority_fee_lamports: u64,
) -> Result<ShieldedCall, PlanError> {
    let implementation = recipe.implementation();
    let doc = implementation.shielded()?.ok_or(PlanError::ShieldedSpend)?;
    let instructions = recipe
        .notes(chain)?
        .map(|built| built.and_then(|built| Instruction::built(&built)))
        .collect::<Result<Vec<_>, _>>()?;
    let pool = instructions.first().map(|entry| entry.program).ok_or(PlanError::ShieldedNote)?;

    let protocol = ShieldedProtocol::try_from(doc.protocol)?;
    let mut spend = ShieldedSpend {
        protocol,
        circuit: circuit(recipe, chain, protocol)?,
        spender: *recipe.address(0).ok_or(PlanError::Unresolved)?,
        notes: Vec::new(),
        deposits: Vec::new(),
        withdrawals: Vec::new(),
    };

    for (index, instruction) in instructions.iter().enumerate() {
        let entry = Entry::read(instruction)?;

        match implementation.shielded_entry(index)?.ok_or(PlanError::ShieldedNote)? {
            ShieldedEntry::Note => spend.notes.push(entry.note()),
            ShieldedEntry::Deposit => spend.deposits.push(entry.leg()?),
            ShieldedEntry::Withdrawal => spend.withdrawals.push(entry.leg()?),
        }
    }

    let payers = recipe.payers();

    Ok(ShieldedCall { pool, spend, fee_payer: *payers.fee, rent_payer: *payers.rent, priority_fee_lamports })
}

/// The caller's spend as the segment's built instructions.
pub(crate) fn built(recipe: &Recipe<'_>, spend: &ShieldedSpend, answer: RemoteAnswer) -> Result<Built, PlanError> {
    let pool = pool(recipe)?;

    if answer.frozen.is_some() {
        return Err(PlanError::ShieldedSpend);
    }

    check_built(&answer.instructions, spend, pool, *recipe.payers().rent)?;

    Built::from_remote(recipe, answer)
}

/// The built instructions of a spend: at least one pool instruction, so the spend can move nothing
/// outside the pool but what the assertions allow. Before them, the spend may create the associated
/// token account of each SPL withdrawal's recipient once, because the pool pays only into an account
/// that exists. The planner and the verifier both check this.
pub(crate) fn check_built(
    instructions: &[Instruction],
    spend: &ShieldedSpend,
    pool: Address,
    rent_payer: Address,
) -> Result<(), PlanError> {
    let creates: Vec<&Instruction> =
        instructions.iter().take_while(|instruction| instruction.program != pool).collect();
    let pool_instructions = instructions.get(creates.len()..).unwrap_or_default();
    let created: Vec<Address> =
        creates.iter().filter_map(|create| create.accounts.get(CREATED_ACCOUNT)).map(|meta| meta.address).collect();
    let created_once = created
        .iter()
        .enumerate()
        .all(|(position, account)| !created.iter().take(position).any(|other| other == account));

    let fits = creates.iter().all(|create| creates_withdrawal_account(create, spend, rent_payer))
        && created_once
        && !pool_instructions.is_empty()
        && pool_instructions.iter().all(|instruction| instruction.program == pool);

    if fits {
        Ok(())
    } else {
        Err(PlanError::ShieldedSpend)
    }
}

/// The position of the account that a `CreateIdempotent` creates.
const CREATED_ACCOUNT: usize = 1;

/// `CreateIdempotent` of the associated token account that an SPL withdrawal pays into, under
/// Token or Token-2022, funded by the rent payer. Any other token program would run in the
/// create, and the pool pays only the account that the mint's own program derives.
fn creates_withdrawal_account(instruction: &Instruction, spend: &ShieldedSpend, rent_payer: Address) -> bool {
    let [funder, account, owner, mint, system, token_program] = instruction.accounts.as_slice() else {
        return false;
    };
    let roles = [funder, account, owner, mint, system, token_program].map(|meta| meta.role);
    let derived =
        find_program_address(&[&owner.address.0, &token_program.address.0, &mint.address.0], &ASSOCIATED_TOKEN_PROGRAM);
    let pays_a_withdrawal = spend
        .withdrawals
        .iter()
        .any(|leg| leg.account == owner.address && leg.asset == mint.address && leg.asset != SOL);

    instruction.program == ASSOCIATED_TOKEN_PROGRAM
        && instruction.data == [CREATE_IDEMPOTENT]
        && roles == CREATE_ROLES
        && funder.address == rent_payer
        && system.address == SYSTEM_PROGRAM
        && (token_program.address == TOKEN_PROGRAM || token_program.address == TOKEN_2022_PROGRAM)
        && derived.is_ok_and(|derived| derived == account.address)
        && pays_a_withdrawal
}

const CREATE_ROLES: [AccountRole; 6] = [
    AccountRole::WritableSigner,
    AccountRole::Writable,
    AccountRole::Readonly,
    AccountRole::Readonly,
    AccountRole::Readonly,
    AccountRole::Readonly,
];

/// The pool program: the program of the recipe's first note.
pub(crate) fn pool(recipe: &Recipe<'_>) -> Result<Address, PlanError> {
    let first = recipe.implementation().instructions()?.first().ok_or(PlanError::ShieldedNote)?;

    recipe.address(first.program).copied().ok_or(PlanError::Unresolved)
}

/// One entry of the statement, as the engine resolved it.
struct Entry {
    account: Address,
    asset: Address,
    amount: u64,
    data: Vec<u8>,
}

impl Entry {
    fn read(instruction: &Instruction) -> Result<Self, PlanError> {
        let [account] = instruction.accounts.as_slice() else {
            return Err(PlanError::ShieldedNote);
        };
        let asset: [u8; 32] = instruction
            .data
            .get(..AMOUNT_START)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(PlanError::ShieldedNote)?;
        let amount: [u8; 8] = instruction
            .data
            .get(AMOUNT_START..AMOUNT_END)
            .and_then(|bytes| bytes.try_into().ok())
            .ok_or(PlanError::ShieldedNote)?;

        Ok(Self {
            account: account.address,
            asset: Address(asset),
            amount: u64::from_le_bytes(amount),
            data: instruction.data.get(AMOUNT_END..).unwrap_or_default().to_vec(),
        })
    }

    fn note(self) -> ShieldedNote {
        ShieldedNote { owner: self.account, asset: self.asset, amount: self.amount, data: self.data }
    }

    /// A deposit or a withdrawal carries no data.
    fn leg(self) -> Result<ShieldedLeg, PlanError> {
        if !self.data.is_empty() {
            return Err(PlanError::ShieldedNote);
        }

        Ok(ShieldedLeg { account: self.account, asset: self.asset, amount: self.amount })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::instruction::AccountMeta;

    const POOL: Address = Address([7; 32]);
    const RENT_PAYER: Address = Address([8; 32]);
    const RECIPIENT: Address = Address([9; 32]);
    const MINT: Address = Address([10; 32]);

    fn spend() -> ShieldedSpend {
        ShieldedSpend {
            protocol: ShieldedProtocol::PrivacyRings,
            circuit: ShieldedCircuit { id: DocumentIdV1::default(), name: String::new(), proving_keys: [0; 32] },
            spender: Address([1; 32]),
            notes: Vec::new(),
            deposits: Vec::new(),
            withdrawals: vec![ShieldedLeg { account: RECIPIENT, asset: MINT, amount: 5 }],
        }
    }

    fn create(token_program: Address) -> Instruction {
        let account =
            find_program_address(&[&RECIPIENT.0, &token_program.0, &MINT.0], &ASSOCIATED_TOKEN_PROGRAM).unwrap();
        let metas = [RENT_PAYER, account, RECIPIENT, MINT, SYSTEM_PROGRAM, token_program];

        Instruction {
            program: ASSOCIATED_TOKEN_PROGRAM,
            accounts: metas
                .iter()
                .zip(CREATE_ROLES)
                .map(|(address, role)| AccountMeta { address: *address, role })
                .collect(),
            data: vec![CREATE_IDEMPOTENT],
        }
    }

    fn pool_call() -> Instruction {
        Instruction { program: POOL, accounts: Vec::new(), data: vec![1] }
    }

    fn check(instructions: &[Instruction]) -> Result<(), PlanError> {
        check_built(instructions, &spend(), POOL, RENT_PAYER)
    }

    #[test]
    fn accepts_one_create_of_a_withdrawal_account_before_the_pool() {
        assert_eq!(check(&[create(TOKEN_PROGRAM), pool_call()]), Ok(()));
        assert_eq!(check(&[create(TOKEN_2022_PROGRAM), pool_call()]), Ok(()));
        assert_eq!(check(&[pool_call()]), Ok(()));
    }

    #[test]
    fn refuses_a_create_under_another_token_program() {
        assert_eq!(check(&[create(Address([11; 32])), pool_call()]), Err(PlanError::ShieldedSpend));
    }

    #[test]
    fn refuses_a_duplicate_create_and_a_create_with_other_roles() {
        assert_eq!(check(&[create(TOKEN_PROGRAM), create(TOKEN_PROGRAM), pool_call()]), Err(PlanError::ShieldedSpend));

        let mut signed_owner = create(TOKEN_PROGRAM);
        signed_owner.accounts[2].role = AccountRole::ReadonlySigner;
        assert_eq!(check(&[signed_owner, pool_call()]), Err(PlanError::ShieldedSpend));
    }

    #[test]
    fn refuses_a_spend_without_a_pool_instruction_or_with_another_program_after_it() {
        assert_eq!(check(&[create(TOKEN_PROGRAM)]), Err(PlanError::ShieldedSpend));
        assert_eq!(check(&[pool_call(), create(TOKEN_PROGRAM)]), Err(PlanError::ShieldedSpend));
    }
}
