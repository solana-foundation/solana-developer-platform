use sdp_intents_engine::{BuiltInstruction, Chain, EngineError, Payers};
use sdp_intents_spec::builder::ReadyInstruction;
use sdp_intents_spec::{AccountRole, Address, SpecError};

/// An instruction that the planner owns, for a simulation or a plan.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Instruction {
    pub program: Address,
    pub accounts: Vec<AccountMeta>,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountMeta {
    pub address: Address,
    pub role: AccountRole,
}

impl Instruction {
    /// A ComputeBudget instruction, which sets the budget of a legacy or v0 transaction.
    pub fn is_budget(&self) -> bool {
        self.program == crate::COMPUTE_BUDGET_PROGRAM
    }

    pub(crate) fn built<C: Chain>(built: &BuiltInstruction<'_, C>) -> Result<Self, EngineError> {
        let accounts = built
            .accounts()
            .map(|account| account.map(|account| AccountMeta { address: *account.address, role: account.role }))
            .collect::<Result<Vec<_>, _>>()?;
        let data =
            built.data().map(|bytes| bytes.map(|bytes| bytes.as_slice().to_vec())).collect::<Result<Vec<_>, _>>()?;

        Ok(Self { program: *built.program, accounts, data: data.concat() })
    }

    /// An instruction of a builder's result. The rent placeholder becomes the rent payer.
    pub(crate) fn ready(ready: &ReadyInstruction<'_>, payers: Payers<'_>) -> Result<Self, SpecError> {
        let accounts = ready
            .accounts
            .iter()
            .map(|meta| Ok(AccountMeta { address: *payers.replace_placeholder(&meta.address), role: meta.role()? }))
            .collect::<Result<Vec<_>, SpecError>>()?;

        Ok(Self { program: *ready.program, accounts, data: ready.data.to_vec() })
    }
}
