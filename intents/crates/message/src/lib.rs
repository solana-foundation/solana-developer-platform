//! Solana messages of each version: legacy, v0, and v1. A message decodes to the planner's
//! [`Transaction`], and a transaction compiles to a message of any version.
//!
//! A v0 message names some accounts through lookup tables. [`WireMessage::lookup_tables`] gives the
//! tables, and the caller fetches them, so decoding does no IO. A legacy or v0 message sets its
//! budget with ComputeBudget instructions. Those instructions stay in the decoded transaction, so
//! each position is the one that the instructions sysvar gives onchain.
//!
//! The crate makes no RPC calls, so it also builds for WebAssembly.

use core::fmt;

use serde_json::Value;
use solana_hash::Hash;
use solana_message::compiled_instruction::CompiledInstruction;
use solana_message::v0::MessageAddressTableLookup;
use solana_message::v1::TransactionConfig;
use solana_message::{legacy, v0, v1, AddressLookupTableAccount, MessageHeader, VersionedMessage};
use solana_transaction::versioned::VersionedTransaction;

use sdp_intents_planner::{
    Account, AccountMeta, Budget, Instruction, Limit, PlanError, Transaction, COMPUTE_BUDGET_PROGRAM,
};
use sdp_intents_spec::{AccountRole, Address};

/// `AddressLookupTab1e1111111111111111111111111`.
const LOOKUP_TABLE_PROGRAM: Address = Address([
    2, 119, 166, 175, 151, 51, 155, 122, 200, 141, 24, 146, 201, 4, 70, 245, 0, 2, 48, 146, 102, 246, 46, 83, 193, 24,
    36, 73, 130, 0, 0, 0,
]);
/// A lookup table holds a 56-byte header, then its addresses. The header starts with the tag of an
/// initialized table, the `u32` 1.
const LOOKUP_TABLE_HEADER_LEN: usize = 56;
const LOOKUP_TABLE_TAG: [u8; 4] = [1, 0, 0, 0];
/// A legacy or v0 transaction is at most one packet.
const PACKET_SIZE: usize = 1_232;
const SIGNATURE_SIZE: usize = 64;
const MICRO_LAMPORTS_PER_LAMPORT: u128 = 1_000_000;
/// The runtime gives each transaction this heap when it requests none.
const DEFAULT_HEAP_SIZE: u32 = 32 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MessageVersion {
    Legacy,
    V0,
    V1,
}

impl MessageVersion {
    /// `"legacy"`, `0`, or `1`, as Kit writes a version.
    pub fn json(self) -> Value {
        match self {
            Self::Legacy => Value::from("legacy"),
            Self::V0 => Value::from(0),
            Self::V1 => Value::from(1),
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "legacy" => Some(Self::Legacy),
            "0" => Some(Self::V0),
            "1" => Some(Self::V1),
            _ => None,
        }
    }
}

/// A serialized message, with what it holds. The bytes are the ones that the signers sign.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WireMessage {
    bytes: Vec<u8>,
    message: VersionedMessage,
}

/// A transaction in wire form: its message, and a signature for each signer. An empty signature is
/// all zeros.
#[derive(Clone, Debug)]
pub struct SignedMessage {
    pub message: WireMessage,
    pub signatures: Vec<[u8; 64]>,
}

/// The addresses that one lookup table holds, in order.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LookupTable {
    pub address: Address,
    pub addresses: Vec<Address>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MessageError {
    Plan(PlanError),
    /// The transaction does not compile to a message of its version.
    Compile(String),
    /// The message, the transaction, or a lookup table does not decode.
    Decode(String),
}

impl From<PlanError> for MessageError {
    fn from(error: PlanError) -> Self {
        Self::Plan(error)
    }
}

impl fmt::Display for MessageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Plan(error) => write!(f, "{error}"),
            Self::Compile(error) => write!(f, "the message does not compile: {error}"),
            Self::Decode(error) => write!(f, "the message does not decode: {error}"),
        }
    }
}

impl std::error::Error for MessageError {}

pub fn solana_address(address: Address) -> solana_address::Address {
    solana_address::Address::new_from_array(address.0)
}

fn base58(address: Address) -> String {
    bs58::encode(address.0).into_string()
}

/// The v1 message of a transaction: what its signers sign.
pub fn v1_message(transaction: &Transaction, blockhash: Hash) -> Result<v1::Message, MessageError> {
    let instructions: Vec<solana_instruction::Instruction> =
        transaction.instructions.iter().map(solana_instruction).collect();
    let budget = transaction.budget;
    let config = TransactionConfig::empty()
        .with_priority_fee(transaction.priority_fee_lamports)
        .with_compute_unit_limit(budget.compute_unit_limit)
        .with_loaded_accounts_data_size_limit(budget.loaded_accounts_data_size_limit)
        .with_heap_size(budget.heap_size);

    v1::Message::try_compile_with_config(&solana_address(transaction.fee_payer), &instructions, blockhash, config)
        .map_err(|error| MessageError::Compile(format!("{error:?}")))
}

fn solana_instruction(instruction: &Instruction) -> solana_instruction::Instruction {
    let accounts = instruction
        .accounts
        .iter()
        .map(|meta| solana_instruction::AccountMeta {
            pubkey: solana_address(meta.address),
            is_signer: meta.role.signer(),
            is_writable: meta.role.writable(),
        })
        .collect();

    solana_instruction::Instruction {
        program_id: solana_address(instruction.program),
        accounts,
        data: instruction.data.clone(),
    }
}

impl WireMessage {
    /// A message of any version. The bytes must be the canonical form of the message, with nothing
    /// after it, because the signers sign these bytes.
    pub fn parse(bytes: &[u8]) -> Result<Self, MessageError> {
        let message: VersionedMessage = wincode::deserialize(bytes).map_err(decode)?;
        let parsed = Self::new(message)?;

        if parsed.bytes != bytes {
            return Err(MessageError::Decode("the message is not in its canonical form".into()));
        }

        Ok(parsed)
    }

    fn new(message: VersionedMessage) -> Result<Self, MessageError> {
        message.sanitize().map_err(decode)?;

        Ok(Self { bytes: message.serialize(), message })
    }

    pub fn bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn version(&self) -> MessageVersion {
        match self.message {
            VersionedMessage::Legacy(_) => MessageVersion::Legacy,
            VersionedMessage::V0(_) => MessageVersion::V0,
            VersionedMessage::V1(_) => MessageVersion::V1,
        }
    }

    pub fn solana(&self) -> &VersionedMessage {
        &self.message
    }

    /// The accounts that must sign, in the order of the signatures.
    pub fn signers(&self) -> Vec<Address> {
        let required = usize::from(self.message.header().num_required_signatures);

        self.message.static_account_keys().iter().take(required).map(|key| Address(key.to_bytes())).collect()
    }

    /// The lookup tables of a v0 message, in the order that its accounts follow.
    pub fn lookup_tables(&self) -> Vec<Address> {
        let lookups = self.message.address_table_lookups().unwrap_or_default();

        lookups.iter().map(|lookup| Address(lookup.account_key.to_bytes())).collect()
    }

    /// The transaction, with the addresses of `tables`. `tables` holds each table that
    /// [`WireMessage::lookup_tables`] names.
    pub fn decode(&self, tables: &[LookupTable]) -> Result<Transaction, MessageError> {
        let keys = self.account_keys(tables)?;
        let key = |index: u8| {
            keys.get(usize::from(index)).copied().ok_or_else(|| MessageError::Decode("an index has no key".into()))
        };
        let instruction = |compiled: &CompiledInstruction| {
            let accounts = compiled.accounts.iter().map(|index| key(*index)).collect::<Result<Vec<_>, _>>()?;

            Ok::<_, MessageError>(Instruction {
                program: key(compiled.program_id_index)?.address,
                accounts,
                data: compiled.data.clone(),
            })
        };
        let instructions = self.message.instructions().iter().map(instruction).collect::<Result<Vec<_>, _>>()?;
        let fee_payer =
            keys.first().ok_or_else(|| MessageError::Decode("the message has no fee payer".into()))?.address;

        let funded = match &self.message {
            VersionedMessage::V1(message) => v1_budget(&message.config),
            _ => instructions
                .iter()
                .filter(|instruction| instruction.is_budget())
                .try_fold(BudgetRequests::default(), |requests, instruction| requests.with(&instruction.data))?
                .budget()?,
        };

        Ok(Transaction {
            fee_payer,
            instructions,
            budget: funded.budget,
            priority_fee_lamports: funded.priority_fee_lamports,
        })
    }

    /// Each account with its role: the static keys, then the writable accounts of every table,
    /// then the readonly ones. A table never holds a signer.
    fn account_keys(&self, tables: &[LookupTable]) -> Result<Vec<AccountMeta>, MessageError> {
        let statics = self.message.static_account_keys();
        let header = self.message.header();
        let static_keys = statics.iter().enumerate().map(|(index, key)| AccountMeta {
            address: Address(key.to_bytes()),
            role: static_role(header, statics.len(), index),
        });
        let lookups = self.message.address_table_lookups().unwrap_or_default();
        let writable = loaded(lookups, tables, Loaded::Writable)?;
        let readonly = loaded(lookups, tables, Loaded::Readonly)?;

        Ok(static_keys.chain(writable).chain(readonly).collect())
    }

    /// The message of `transaction` at `blockhash`. A legacy or v0 message sets the budget and the
    /// priority fee with ComputeBudget instructions before the transaction's own. Its price for
    /// each compute unit rounds down, so its priority fee can be below the transaction's.
    pub fn compile(
        transaction: &Transaction,
        blockhash: Hash,
        version: MessageVersion,
        tables: &[LookupTable],
    ) -> Result<Self, MessageError> {
        let payer = solana_address(transaction.fee_payer);
        let failed = |error: solana_message::CompileError| MessageError::Compile(format!("{error:?}"));

        let message = match version {
            MessageVersion::V1 => VersionedMessage::V1(v1_message(transaction, blockhash)?),
            MessageVersion::Legacy => VersionedMessage::Legacy(legacy::Message::new_with_blockhash(
                &budgeted_instructions(transaction)?,
                Some(&payer),
                &blockhash,
            )),
            MessageVersion::V0 => {
                let tables: Vec<AddressLookupTableAccount> = tables.iter().map(LookupTable::solana).collect();
                let instructions = budgeted_instructions(transaction)?;

                VersionedMessage::V0(
                    v0::Message::try_compile(&payer, &instructions, &tables, blockhash).map_err(failed)?,
                )
            }
        };

        Self::new(message)
    }

    /// The transaction in wire form, with a signature for each signer. An empty signature is all
    /// zeros.
    pub fn signed(&self, signatures: &[[u8; 64]]) -> Result<Vec<u8>, MessageError> {
        let signatures = signatures.iter().copied().map(solana_signature::Signature::from).collect();
        let transaction = VersionedTransaction { signatures, message: self.message.clone() };

        wincode::serialize(&transaction).map_err(decode)
    }

    /// Fails with `DoesNotFit` when the signed transaction is over its version's limit: 4,096 bytes
    /// for v1, and one packet for legacy and v0.
    pub fn check_size(&self) -> Result<(), MessageError> {
        let signatures = usize::from(self.message.header().num_required_signatures);
        let signature_bytes = signatures.saturating_mul(SIGNATURE_SIZE);
        let (size, max) = match self.version() {
            MessageVersion::V1 => (self.bytes.len().saturating_add(signature_bytes), v1::MAX_TRANSACTION_SIZE),
            _ => {
                (compact_len(signatures).saturating_add(signature_bytes).saturating_add(self.bytes.len()), PACKET_SIZE)
            }
        };

        if size > max {
            return Err(PlanError::DoesNotFit { limit: Limit::Bytes, used: size, max }.into());
        }

        Ok(())
    }
}

/// A signed transaction of any version, in wire form. A legacy or v0 transaction writes its
/// signatures before the message, and a v1 transaction writes them after it.
pub fn read_transaction(bytes: &[u8]) -> Result<SignedMessage, MessageError> {
    let transaction: VersionedTransaction = wincode::deserialize(bytes).map_err(decode)?;
    let signatures: Vec<[u8; 64]> =
        transaction.signatures.iter().map(|signature| <[u8; 64]>::from(*signature)).collect();
    let message = WireMessage::new(transaction.message)?;

    if signatures.len() != message.signers().len() {
        return Err(MessageError::Decode("the transaction holds another count of signatures than its signers".into()));
    }

    let signature_bytes = signatures.len().saturating_mul(SIGNATURE_SIZE);
    let prefix = if message.version() == MessageVersion::V1 { 0 } else { compact_len(signatures.len()) };

    if prefix.saturating_add(signature_bytes).saturating_add(message.bytes.len()) != bytes.len() {
        return Err(MessageError::Decode("the transaction is not in its canonical form".into()));
    }

    Ok(SignedMessage { message, signatures })
}

impl LookupTable {
    /// The table at `address`, as `getMultipleAccounts` returned it.
    pub fn read(address: Address, account: Option<&Account>) -> Result<Self, MessageError> {
        let invalid = |reason: &str| MessageError::Decode(format!("the lookup table {} {reason}", base58(address)));
        let account = account.ok_or_else(|| invalid("does not exist"))?;

        if account.owner != LOOKUP_TABLE_PROGRAM || account.data.get(..4) != Some(&LOOKUP_TABLE_TAG[..]) {
            return Err(invalid("is not an address lookup table"));
        }

        let stored = account.data.get(LOOKUP_TABLE_HEADER_LEN..).ok_or_else(|| invalid("is too short"))?;
        let (chunks, rest) = stored.as_chunks::<32>();

        if !rest.is_empty() {
            return Err(invalid("holds a partial address"));
        }

        Ok(Self { address, addresses: chunks.iter().copied().map(Address).collect() })
    }

    fn solana(&self) -> AddressLookupTableAccount {
        AddressLookupTableAccount {
            key: solana_address(self.address),
            addresses: self.addresses.iter().copied().map(solana_address).collect(),
        }
    }
}

#[derive(Clone, Copy)]
enum Loaded {
    Writable,
    Readonly,
}

fn loaded(
    lookups: &[MessageAddressTableLookup],
    tables: &[LookupTable],
    kind: Loaded,
) -> Result<Vec<AccountMeta>, MessageError> {
    let role = match kind {
        Loaded::Writable => AccountRole::Writable,
        Loaded::Readonly => AccountRole::Readonly,
    };

    lookups
        .iter()
        .map(|lookup| {
            let address = Address(lookup.account_key.to_bytes());
            let table = tables
                .iter()
                .find(|table| table.address == address)
                .ok_or_else(|| MessageError::Decode(format!("the lookup table {} was not fetched", base58(address))))?;
            let indexes = match kind {
                Loaded::Writable => &lookup.writable_indexes,
                Loaded::Readonly => &lookup.readonly_indexes,
            };

            indexes
                .iter()
                .map(|index| {
                    let address = table.addresses.get(usize::from(*index)).copied().ok_or_else(|| {
                        MessageError::Decode(format!("the lookup table {} has no index {index}", base58(address)))
                    })?;

                    Ok(AccountMeta { address, role })
                })
                .collect::<Result<Vec<_>, MessageError>>()
        })
        .collect::<Result<Vec<_>, _>>()
        .map(|per_table| per_table.concat())
}

/// The header gives each static key's role: the signers come first, writable before readonly, then
/// the other writable accounts, then the readonly ones.
fn static_role(header: &MessageHeader, keys: usize, index: usize) -> AccountRole {
    let signers = usize::from(header.num_required_signatures);
    let writable_signers = signers.saturating_sub(usize::from(header.num_readonly_signed_accounts));
    let writable_end = keys.saturating_sub(usize::from(header.num_readonly_unsigned_accounts));
    let writable = index < writable_signers || (index >= signers && index < writable_end);

    AccountRole::new(writable, index < signers)
}

/// A budget and the total priority fee in lamports.
struct Funded {
    budget: Budget,
    priority_fee_lamports: u64,
}

fn v1_budget(config: &v1::TransactionConfig) -> Funded {
    Funded {
        budget: Budget {
            compute_unit_limit: config.compute_unit_limit.unwrap_or_default(),
            loaded_accounts_data_size_limit: config.loaded_accounts_data_size_limit.unwrap_or_default(),
            heap_size: config.heap_size.unwrap_or_default(),
        },
        priority_fee_lamports: config.priority_fee.unwrap_or_default(),
    }
}

/// What the ComputeBudget instructions of a legacy or v0 message request. The runtime refuses a
/// transaction that requests one value twice, so decoding refuses it too.
#[derive(Default)]
struct BudgetRequests {
    heap_size: Option<u32>,
    compute_unit_limit: Option<u32>,
    micro_lamports_per_unit: Option<u64>,
    loaded_accounts_data_size_limit: Option<u32>,
}

impl BudgetRequests {
    fn with(self, data: &[u8]) -> Result<Self, MessageError> {
        let twice = || MessageError::Decode("a ComputeBudget instruction requests a value twice".into());
        let unknown = || MessageError::Decode("a ComputeBudget instruction does not decode".into());
        let u32_of = |rest: &[u8]| <[u8; 4]>::try_from(rest).map(u32::from_le_bytes).map_err(|_| unknown());

        match data.split_first() {
            Some((1, rest)) if self.heap_size.is_none() => Ok(Self { heap_size: Some(u32_of(rest)?), ..self }),
            Some((2, rest)) if self.compute_unit_limit.is_none() => {
                Ok(Self { compute_unit_limit: Some(u32_of(rest)?), ..self })
            }
            Some((3, rest)) if self.micro_lamports_per_unit.is_none() => {
                let price = <[u8; 8]>::try_from(rest).map(u64::from_le_bytes).map_err(|_| unknown())?;

                Ok(Self { micro_lamports_per_unit: Some(price), ..self })
            }
            Some((4, rest)) if self.loaded_accounts_data_size_limit.is_none() => {
                Ok(Self { loaded_accounts_data_size_limit: Some(u32_of(rest)?), ..self })
            }
            Some((1..=4, _)) => Err(twice()),
            _ => Err(unknown()),
        }
    }

    /// The runtime charges the price for each unit of the limit, rounded up to a lamport. With a
    /// price and no limit, the fee depends on the runtime's default limit, so decoding refuses it.
    fn budget(self) -> Result<Funded, MessageError> {
        let priority_fee_lamports = match (self.micro_lamports_per_unit, self.compute_unit_limit) {
            (None | Some(0), _) => 0,
            (Some(_), None) => {
                return Err(MessageError::Decode("the message sets a compute unit price and no limit".into()));
            }
            (Some(price), Some(limit)) => {
                let micro_lamports = u128::from(price).saturating_mul(u128::from(limit));

                u64::try_from(micro_lamports.div_ceil(MICRO_LAMPORTS_PER_LAMPORT)).unwrap_or(u64::MAX)
            }
        };
        let budget = Budget {
            compute_unit_limit: self.compute_unit_limit.unwrap_or_default(),
            loaded_accounts_data_size_limit: self.loaded_accounts_data_size_limit.unwrap_or_default(),
            heap_size: self.heap_size.unwrap_or_default(),
        };

        Ok(Funded { budget, priority_fee_lamports })
    }
}

/// The ComputeBudget instructions of the transaction's budget and priority fee, then its own
/// instructions.
fn budgeted_instructions(transaction: &Transaction) -> Result<Vec<solana_instruction::Instruction>, MessageError> {
    let budget = transaction.budget;
    let fee = transaction.priority_fee_lamports;

    if fee > 0 && budget.compute_unit_limit == 0 {
        return Err(MessageError::Compile("a priority fee needs a compute unit limit".into()));
    }

    let price = u128::from(fee)
        .saturating_mul(MICRO_LAMPORTS_PER_LAMPORT)
        .checked_div(u128::from(budget.compute_unit_limit))
        .unwrap_or_default();
    let requests = [
        (budget.compute_unit_limit > 0).then(|| [&[2][..], &budget.compute_unit_limit.to_le_bytes()].concat()),
        (fee > 0).then(|| [&[3][..], &u64::try_from(price).unwrap_or(u64::MAX).to_le_bytes()].concat()),
        (budget.loaded_accounts_data_size_limit > 0)
            .then(|| [&[4][..], &budget.loaded_accounts_data_size_limit.to_le_bytes()].concat()),
        (budget.heap_size > DEFAULT_HEAP_SIZE).then(|| [&[1][..], &budget.heap_size.to_le_bytes()].concat()),
    ];
    let budget_instructions = requests.into_iter().flatten().map(|data| solana_instruction::Instruction {
        program_id: solana_address(COMPUTE_BUDGET_PROGRAM),
        accounts: Vec::new(),
        data,
    });

    Ok(budget_instructions.chain(transaction.instructions.iter().map(solana_instruction)).collect())
}

/// The length of a compact `u16` that holds `value`: 7 bits a byte.
fn compact_len(value: usize) -> usize {
    match value {
        0..0x80 => 1,
        0x80..0x4000 => 2,
        _ => 3,
    }
}

fn decode(error: impl core::fmt::Debug) -> MessageError {
    MessageError::Decode(format!("{error:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const FEE_PAYER: Address = Address([1; 32]);
    const PROGRAM: Address = Address([9; 32]);

    fn meta(byte: u8, role: AccountRole) -> AccountMeta {
        AccountMeta { address: Address([byte; 32]), role }
    }

    fn transaction(priority_fee_lamports: u64) -> Transaction {
        Transaction {
            fee_payer: FEE_PAYER,
            instructions: vec![Instruction {
                program: PROGRAM,
                accounts: vec![
                    meta(1, AccountRole::WritableSigner),
                    meta(2, AccountRole::ReadonlySigner),
                    meta(3, AccountRole::Writable),
                    meta(4, AccountRole::Readonly),
                ],
                data: vec![7, 8],
            }],
            budget: Budget { compute_unit_limit: 20_000, loaded_accounts_data_size_limit: 9_000, heap_size: 64 * 1024 },
            priority_fee_lamports,
        }
    }

    fn table() -> LookupTable {
        LookupTable { address: Address([5; 32]), addresses: vec![Address([3; 32]), Address([4; 32])] }
    }

    fn table_account(table: &LookupTable) -> Account {
        let addresses: Vec<u8> = table.addresses.iter().flat_map(|address| address.0).collect();
        let header = [&LOOKUP_TABLE_TAG[..], &[0xff; 8], &[0; LOOKUP_TABLE_HEADER_LEN - 12]].concat();

        Account { owner: LOOKUP_TABLE_PROGRAM, lamports: 1, data: [header, addresses].concat() }
    }

    /// Each version decodes to the transaction that compiled it. A legacy or v0 message holds its
    /// budget as ComputeBudget instructions before the transaction's own.
    #[test]
    fn each_version_decodes_to_the_transaction_that_compiled_it() {
        let original = transaction(5_000);

        for version in [MessageVersion::Legacy, MessageVersion::V0, MessageVersion::V1] {
            let message = WireMessage::compile(&original, Hash::default(), version, &[]).unwrap();
            let parsed = WireMessage::parse(message.bytes()).unwrap();
            let decoded = parsed.decode(&[]).unwrap();
            let own: Vec<&Instruction> =
                decoded.instructions.iter().filter(|instruction| !instruction.is_budget()).collect();

            assert_eq!(parsed.version(), version);
            assert_eq!(decoded.fee_payer, FEE_PAYER);
            assert_eq!(own, original.instructions.iter().collect::<Vec<_>>());
            assert_eq!(decoded.budget, original.budget);
            assert_eq!(decoded.priority_fee_lamports, 5_000);
        }
    }

    /// A v0 message reads the accounts of its table after its static keys, and none of them signs.
    #[test]
    fn a_v0_message_reads_its_lookup_table() {
        let table = table();
        let message =
            WireMessage::compile(&transaction(0), Hash::default(), MessageVersion::V0, core::slice::from_ref(&table))
                .unwrap();
        let read = LookupTable::read(table.address, Some(&table_account(&table))).unwrap();

        assert_eq!(message.lookup_tables(), [table.address]);
        assert_eq!(read, table);
        let decoded = message.decode(&[read]).unwrap();
        let own: Vec<Instruction> =
            decoded.instructions.into_iter().filter(|instruction| !instruction.is_budget()).collect();

        assert_eq!(own, transaction(0).instructions);
        assert!(message.decode(&[]).is_err());
    }

    #[test]
    fn a_lookup_table_has_its_program_and_tag() {
        let table = table();
        let other_owner = Account { owner: PROGRAM, ..table_account(&table) };
        let uninitialized = Account { data: vec![0; LOOKUP_TABLE_HEADER_LEN], ..table_account(&table) };

        assert!(LookupTable::read(table.address, None).is_err());
        assert!(LookupTable::read(table.address, Some(&other_owner)).is_err());
        assert!(LookupTable::read(table.address, Some(&uninitialized)).is_err());
    }

    /// The runtime charges the price for each unit of the limit, rounded up to a lamport. A price
    /// with no limit leaves the fee to the runtime's default.
    #[test]
    fn a_compute_unit_price_gives_the_priority_fee() {
        let price = |micro_lamports: u64| [&[3][..], &micro_lamports.to_le_bytes()].concat();
        let limit = [&[2][..], &30_000u32.to_le_bytes()].concat();
        let fee = |requests: &[&[u8]]| {
            requests.iter().try_fold(BudgetRequests::default(), |requests, data| requests.with(data))?.budget()
        };

        assert_eq!(fee(&[&limit, &price(1_000_001)]).unwrap().priority_fee_lamports, 30_001);
        assert_eq!(fee(&[&limit]).unwrap().priority_fee_lamports, 0);
        assert!(fee(&[&price(1)]).is_err());
        assert!(fee(&[&limit, &limit]).is_err());
        assert!(fee(&[&[9]]).is_err());
    }

    /// A legacy message sets the price that rounds down, so its fee is at most the transaction's.
    #[test]
    fn a_legacy_priority_fee_rounds_down() {
        let original = Transaction {
            budget: Budget { compute_unit_limit: 30_000, ..transaction(0).budget },
            ..transaction(10_001)
        };
        let message = WireMessage::compile(&original, Hash::default(), MessageVersion::Legacy, &[]).unwrap();

        assert_eq!(message.decode(&[]).unwrap().priority_fee_lamports, 10_001);
    }

    #[test]
    fn a_message_with_bytes_past_its_end_does_not_parse() {
        let message = WireMessage::compile(&transaction(0), Hash::default(), MessageVersion::Legacy, &[]).unwrap();

        assert!(WireMessage::parse(&[message.bytes(), &[0]].concat()).is_err());
    }

    #[test]
    fn a_legacy_transaction_fits_one_packet() {
        let large = Transaction {
            instructions: vec![Instruction { program: PROGRAM, accounts: Vec::new(), data: vec![0; 1_200] }],
            ..transaction(0)
        };
        let compile = |version| WireMessage::compile(&large, Hash::default(), version, &[]).unwrap();

        assert!(compile(MessageVersion::Legacy).check_size().is_err());
        assert!(compile(MessageVersion::V1).check_size().is_ok());
    }
}
