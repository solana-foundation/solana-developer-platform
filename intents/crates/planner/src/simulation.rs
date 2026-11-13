//! The simulations that the planner asks for, and the answers it reads.

use sdp_intents_engine::{BuiltInstruction, Chain, EngineError};
use sdp_intents_spec::{AccountRole, Address};

use crate::{Account, AccountMeta, Instruction, Transaction};

/// The rent-exempt minimum for scratch: (10,240 + 128) bytes at 6,960 lamports a byte. A simulation
/// lands nothing, so this amount only has to be in the funder's balance.
const SCRATCH_RENT_LAMPORTS: u64 = 72_161_280;
const SCRATCH_LEN: u64 = 10_240;
const SYSTEM_CREATE_ACCOUNT: [u8; 4] = [0, 0, 0, 0];

/// A transaction for the caller to simulate, with signatures unchecked and any blockhash.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Simulation {
    pub transaction: Transaction,
    /// The accounts whose state after the run the result must hold, in this order.
    pub observe: Vec<Address>,
    /// The message to run in place of `transaction` when it is set. `transaction` then holds what
    /// the message decodes to, so the caller can load its accounts.
    pub fixed: Option<FixedMessage>,
}

/// A serialized message that the simulation runs as it is, such as a provider's signed message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FixedMessage {
    pub bytes: Vec<u8>,
    pub lookup_tables: Vec<Address>,
}

/// What a simulation returned. `accounts` follows the order of `Simulation::observe`, and `None`
/// is an account that does not exist after the run.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SimulationResult {
    pub error: Option<String>,
    pub logs: Vec<String>,
    pub return_data: Option<ReturnData>,
    pub accounts: Vec<Option<Account>>,
    pub units_consumed: Option<u64>,
    pub loaded_accounts_data_size: Option<u32>,
    /// The fee that the runtime charged, when the RPC reports it.
    pub fee: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReturnData {
    pub program: Address,
    pub data: Vec<u8>,
}

impl Simulation {
    /// A staged builder call. The transaction runs `earlier`, then creates scratch, owned by the
    /// builder, then calls the builder with scratch as its last account. `funder` pays the fee and
    /// the scratch rent.
    pub(crate) fn staged<C: Chain>(
        call: &BuiltInstruction<'_, C>,
        earlier: &[Instruction],
        funder: Address,
        scratch: Address,
    ) -> Result<Self, EngineError> {
        let builder = *call.program;
        let create_scratch = Instruction {
            program: Address::default(),
            accounts: vec![
                AccountMeta { address: funder, role: AccountRole::WritableSigner },
                AccountMeta { address: scratch, role: AccountRole::WritableSigner },
            ],
            data: [
                &SYSTEM_CREATE_ACCOUNT[..],
                &SCRATCH_RENT_LAMPORTS.to_le_bytes(),
                &SCRATCH_LEN.to_le_bytes(),
                &builder.0,
            ]
            .concat(),
        };

        let mut call = Instruction::built(call)?;
        call.accounts.push(AccountMeta { address: scratch, role: AccountRole::Writable });

        let instructions = earlier.iter().cloned().chain([create_scratch, call]).collect();
        let transaction = Transaction::unbudgeted(funder, instructions);

        Ok(Self { transaction, observe: vec![scratch], fixed: None })
    }
}
