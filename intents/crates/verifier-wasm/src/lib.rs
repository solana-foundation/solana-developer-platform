//! The planner's verifier as a WebAssembly module, which `@sdp/intents-verifier` loads. A signer
//! runs it in its own process against its own RPC, so the service that planned a transaction does
//! not also verify it.
//!
//! The module does no IO. Each [`step`] takes a message and every account that the caller fetched
//! so far. It returns the accounts to fetch next, or what the message proves. The lookup tables
//! come first, because the message decodes only with them.
//!
//! allow-verbose: the input layout is a wire format that `@sdp/intents-verifier` builds bytes from.
//! The input is little-endian:
//!
//! ```text
//! u32 message_len, message
//! u32 account_count, then for each account:
//!   u8 address_len, address as base58
//!   u8 exists, and when it is 1:
//!     u8 owner_len, owner as base58, u64 lamports, u32 data_len, data
//! ```
//!
//! The output is JSON: `{ "fetch": [address] }`, `{ "verified": { message, intents, unverified } }`,
//! or `{ "error": { code, message } }`.

mod input;

use std::sync::{Mutex, PoisonError};

use serde_json::{json, Value};

use sdp_intents_message::{LookupTable, WireMessage};
use sdp_intents_planner::{verify_transaction, AccountMap, VerifiedIntent, VerifiedTransaction, VerifyStep};
use sdp_intents_spec::Address;

pub use input::{Input, InputError};

/// The input that JavaScript writes and the output that it reads. Both live in the module's memory,
/// so JavaScript reads them through a pointer.
static INPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());
static OUTPUT: Mutex<Vec<u8>> = Mutex::new(Vec::new());

/// Resizes the input to `len` bytes and returns where it starts. The pointer is valid until the
/// next call.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn input(len: usize) -> *mut u8 {
    let mut input = INPUT.lock().unwrap_or_else(PoisonError::into_inner);
    input.clear();
    input.resize(len, 0);

    input.as_mut_ptr()
}

/// Runs [`step`] on the input, and returns the length of the JSON that [`output`] points at.
#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn verify() -> usize {
    let answer = step_json(&INPUT.lock().unwrap_or_else(PoisonError::into_inner)).to_string();
    let mut output = OUTPUT.lock().unwrap_or_else(PoisonError::into_inner);
    *output = answer.into_bytes();

    output.len()
}

#[allow(unsafe_code)]
#[no_mangle]
pub extern "C" fn output() -> *const u8 {
    OUTPUT.lock().unwrap_or_else(PoisonError::into_inner).as_ptr()
}

/// What the verifier needs next, or what it found.
#[derive(Debug)]
pub enum Step {
    Fetch(Vec<Address>),
    Verified(Box<VerifiedTransaction>),
}

#[derive(Debug)]
pub enum StepError {
    Input(InputError),
    Message(sdp_intents_message::MessageError),
    Verify(sdp_intents_planner::VerifyError),
}

impl StepError {
    fn code(&self) -> &'static str {
        match self {
            Self::Input(_) => "badInput",
            Self::Message(_) => "badMessage",
            Self::Verify(_) => "doesNotVerify",
        }
    }
}

impl core::fmt::Display for StepError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Input(error) => write!(f, "{error}"),
            Self::Message(error) => write!(f, "{error}"),
            Self::Verify(error) => write!(f, "the transaction does not verify: {error}"),
        }
    }
}

pub fn step(input: &Input) -> Result<Step, StepError> {
    let message = WireMessage::parse(&input.message).map_err(StepError::Message)?;
    let table_addresses = message.lookup_tables();
    let missing_tables: Vec<Address> =
        table_addresses.iter().filter(|address| input.account(address).is_none()).copied().collect();

    if !missing_tables.is_empty() {
        return Ok(Step::Fetch(missing_tables));
    }

    let tables = table_addresses
        .iter()
        .map(|address| LookupTable::read(*address, input.account(address).flatten()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(StepError::Message)?;
    let transaction = message.decode(&tables).map_err(StepError::Message)?;

    let mut accounts = AccountMap::default();
    let (addresses, fetched): (Vec<Address>, Vec<_>) = input.accounts.iter().cloned().unzip();
    accounts.insert_fetched(&addresses, fetched);

    match verify_transaction(&transaction, &accounts).map_err(StepError::Verify)? {
        VerifyStep::Fetch(addresses) => Ok(Step::Fetch(addresses)),
        VerifyStep::Done(verified) => Ok(Step::Verified(verified)),
    }
}

fn step_json(bytes: &[u8]) -> Value {
    let answer = Input::parse(bytes).map_err(StepError::Input).and_then(|input| step(&input));

    match answer {
        Ok(Step::Fetch(addresses)) => json!({ "fetch": addresses.iter().map(base58).collect::<Vec<_>>() }),
        Ok(Step::Verified(verified)) => json!({ "verified": verified_json(&verified) }),
        Err(error) => json!({ "error": { "code": error.code(), "message": error.to_string() } }),
    }
}

/// The same fields as `/v1/verify` of the service, without `matches`: the caller compares the
/// message with the one that it expects.
fn verified_json(verified: &VerifiedTransaction) -> Value {
    let intent = |intent: &VerifiedIntent| {
        json!({
            "verify": intent.verify,
            "built": { "start": intent.built.start, "end": intent.built.end },
            "segment": { "start": intent.segment.start, "end": intent.segment.end },
        })
    };

    json!({
        "message": verified.message,
        "intents": verified.intents.iter().map(intent).collect::<Vec<_>>(),
        "unverified": verified.unverified,
    })
}

fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

#[cfg(test)]
mod tests {
    use sdp_intents_message::MessageVersion;
    use sdp_intents_planner::{Account, Budget, Instruction, Transaction};
    use solana_hash::Hash;

    use super::*;

    const FEE_PAYER: Address = Address([1; 32]);
    const TABLE: Address = Address([5; 32]);

    fn transaction() -> Transaction {
        Transaction {
            fee_payer: FEE_PAYER,
            instructions: vec![Instruction { program: Address([9; 32]), accounts: Vec::new(), data: vec![1] }],
            budget: Budget { compute_unit_limit: 20_000, loaded_accounts_data_size_limit: 9_000, heap_size: 64 * 1024 },
            priority_fee_lamports: 0,
        }
    }

    /// The bytes that `@sdp/intents-verifier` writes for `message` and `accounts`.
    fn encoded(message: &[u8], accounts: &[(Address, Option<Account>)]) -> Vec<u8> {
        let address = |address: &Address| {
            let text = base58(address);

            [&[text.len() as u8][..], text.as_bytes()].concat()
        };
        let account = |(key, account): &(Address, Option<Account>)| match account {
            None => [address(key), vec![0]].concat(),
            Some(account) => [
                address(key),
                vec![1],
                address(&account.owner),
                account.lamports.to_le_bytes().to_vec(),
                (account.data.len() as u32).to_le_bytes().to_vec(),
                account.data.clone(),
            ]
            .concat(),
        };

        [
            (message.len() as u32).to_le_bytes().to_vec(),
            message.to_vec(),
            (accounts.len() as u32).to_le_bytes().to_vec(),
            accounts.iter().flat_map(account).collect(),
        ]
        .concat()
    }

    #[test]
    fn reads_the_input_that_the_library_writes() {
        let accounts = vec![
            (Address([2; 32]), None),
            (Address([3; 32]), Some(Account { owner: TABLE, lamports: 7, data: vec![4] })),
        ];
        let bytes = encoded(&[8, 9], &accounts);

        assert_eq!(Input::parse(&bytes), Ok(Input { message: vec![8, 9], accounts }));
        assert_eq!(Input::parse(&[&bytes[..], &[0]].concat()), Err(InputError::TrailingBytes));
        assert!(matches!(Input::parse(&bytes[..bytes.len() - 1]), Err(InputError::Truncated(_))));
    }

    /// A v0 message decodes only with its lookup tables, so they are the first fetch.
    #[test]
    fn fetches_the_lookup_tables_first() {
        let table = LookupTable { address: TABLE, addresses: vec![Address([3; 32])] };
        let mut with_table = transaction();
        with_table.instructions[0].accounts = vec![sdp_intents_planner::AccountMeta {
            address: Address([3; 32]),
            role: sdp_intents_spec::AccountRole::Readonly,
        }];
        let message = WireMessage::compile(&with_table, Hash::default(), MessageVersion::V0, &[table]).unwrap();

        let answer = step_json(&encoded(message.bytes(), &[]));

        assert_eq!(answer, json!({ "fetch": [base58(&TABLE)] }));
    }

    /// A transaction with no `verify_intent` proves only its payers, and lists its instruction.
    #[test]
    fn lists_each_instruction_that_no_segment_holds() {
        let message = WireMessage::compile(&transaction(), Hash::default(), MessageVersion::V1, &[]).unwrap();

        let answer = step_json(&encoded(message.bytes(), &[]));

        assert_eq!(answer["verified"]["intents"], json!([]));
        assert_eq!(answer["verified"]["unverified"], json!([0]));
    }

    #[test]
    fn answers_an_error_as_json() {
        assert_eq!(step_json(&[1, 0, 0, 0])["error"]["code"], "badInput");
        assert_eq!(step_json(&encoded(&[0xff], &[]))["error"]["code"], "badMessage");
    }
}
