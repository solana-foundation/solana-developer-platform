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

#[cfg(test)]
mod tests {
    use super::*;

    /// A builtin logs no units, and an inner call's units count in its top-level instruction.
    #[test]
    fn reads_the_units_of_each_top_level_instruction() {
        let logs: Vec<String> = [
            "Program 11111111111111111111111111111111 invoke [1]",
            "Program 11111111111111111111111111111111 success",
            "Program Reg invoke [1]",
            "Program Token invoke [2]",
            "Program Token consumed 4645 of 190000 compute units",
            "Program Token success",
            "Program Reg consumed 21000 of 199850 compute units",
            "Program Reg success",
            "Program Light invoke [1]",
            "Program Light consumed 900 of 178850 compute units",
            "Program Light failed: custom program error: 0x1",
        ]
        .map(String::from)
        .to_vec();

        assert_eq!(units_by_instruction(&logs), [None, Some(21_000), Some(900)]);
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReturnData {
    pub program: Address,
    pub data: Vec<u8>,
}

/// The compute units of each top-level instruction, read from the program logs. A builtin
/// program, such as the System program, logs no units, so its entry is `None`.
pub(crate) fn units_by_instruction(logs: &[String]) -> Vec<Option<u64>> {
    logs.iter().fold(Tally::default(), |tally, line| tally.read(line)).units
}

/// The units of each top-level instruction so far, and the depth of the running invocation.
#[derive(Default)]
struct Tally {
    units: Vec<Option<u64>>,
    depth: usize,
}

impl Tally {
    /// `Program <id> invoke [<depth>]`, `Program <id> consumed <n> of <m> compute units`, and
    /// `Program <id> success` or `Program <id> failed: <reason>`.
    fn read(mut self, line: &str) -> Self {
        let words: Vec<&str> = line.split_whitespace().collect();

        match words.as_slice() {
            ["Program", _, "invoke", depth] => {
                self.depth = depth.trim_matches(['[', ']']).parse().unwrap_or(self.depth);
                if self.depth == 1 {
                    self.units.push(None);
                }
            }
            ["Program", _, "consumed", units, "of", _, "compute", "units"] if self.depth == 1 => {
                if let Some(last) = self.units.last_mut() {
                    *last = units.parse().ok();
                }
            }
            ["Program", _, "success"] => self.depth = self.depth.saturating_sub(1),
            ["Program", _, failed, ..] if failed.starts_with("failed") => self.depth = self.depth.saturating_sub(1),
            _ => {}
        }

        self
    }
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
