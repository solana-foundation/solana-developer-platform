//! The onchain checks of a segment: `verify_intent`, and the Lighthouse snapshots and assertions
//! around the built instructions. The segment's simulation runs them with a placeholder rent cap,
//! and the planner builds them again with the rent cap that the simulation measures.

use sdp_intents_engine::Recipe;
use sdp_intents_lighthouse::{
    guarded_addresses, Guard, GuardedAccount, LighthouseInstruction, Memory, LIGHTHOUSE_PROGRAM,
};
use sdp_intents_spec::{Address, RecipeKind};

use crate::plan::Built;
use crate::registry::{SegmentCounts, VerifyIntent};
use crate::{Account, AccountMeta, Instruction, PlanError};

/// The rent cap of the simulation, before it measures the rent. Any rent passes it.
pub(crate) const PLACEHOLDER_RENT_CAP: u64 = u64::MAX;

/// The instructions that the segment adds around its built instructions.
#[derive(Default)]
pub(crate) struct OnchainChecks {
    pub(crate) verify: Option<Instruction>,
    pub(crate) snapshots: Vec<Instruction>,
    pub(crate) checks: Vec<Instruction>,
}

pub(crate) struct OnchainInputs<'o, 'a> {
    pub(crate) recipe: &'o Recipe<'a>,
    pub(crate) intent: &'o [u8],
    pub(crate) built: &'o Built,
    pub(crate) extra_accounts: &'o [Address],
    /// The accounts that the segment can change, and each one's state before the segment.
    pub(crate) observed: &'o [Address],
    pub(crate) before: &'o [Account],
    pub(crate) rent_cap: u64,
    /// The segment's position in the plan, which names its Lighthouse memory.
    pub(crate) memory_id: u8,
}

impl OnchainInputs<'_, '_> {
    pub(crate) fn checks(&self) -> Result<OnchainChecks, PlanError> {
        let options = self.recipe.intent().options()?;
        let fee_payer = self.recipe.payers().fee;
        let named = self.built.instructions.iter().flat_map(|instruction| {
            instruction
                .accounts
                .iter()
                .map(|meta| sdp_intents_lighthouse::Meta { address: meta.address, role: meta.role })
        });
        let guarded = if options.assertions { guarded_addresses(named, fee_payer) } else { Vec::new() };

        let assertions = if options.assertions { self.assertions(&guarded)? } else { Default::default() };
        let counts = SegmentCounts {
            snapshots: count(assertions.snapshots.len())?,
            built: count(self.built.instructions.len())?,
            checks: count(assertions.checks.len())?,
        };
        let verify = options.verify_intent.then(|| self.verify_instruction(&guarded, counts)).transpose()?;

        Ok(OnchainChecks {
            verify,
            snapshots: assertions.snapshots.iter().map(lighthouse_instruction).collect(),
            checks: assertions.checks.iter().map(lighthouse_instruction).collect(),
        })
    }

    /// A builder's roles come from its instructions, and a static recipe has none.
    fn verify_instruction(&self, guarded: &[Address], counts: SegmentCounts) -> Result<Instruction, PlanError> {
        let builder_roles = match self.recipe.implementation().recipe()? {
            RecipeKind::Program | RecipeKind::Remote => self.built.roles(),
            RecipeKind::Static | RecipeKind::RemoteTransaction | RecipeKind::Shielded => Vec::new(),
        };
        let bumps = self.recipe.bumps()?;
        let verify = VerifyIntent {
            intent: self.intent,
            extra_accounts: self.extra_accounts,
            builder_roles,
            outputs: &self.built.outputs,
            bumps: bumps.as_slice(),
            builder_bumps: &self.built.builder_bumps,
            rent_cap: self.rent_cap,
            guarded,
            counts,
        };

        verify.instruction(self.recipe)
    }

    fn assertions(&self, guarded: &[Address]) -> Result<sdp_intents_lighthouse::Assertions, PlanError> {
        let accounts = guarded
            .iter()
            .map(|address| {
                let position = self.observed.iter().position(|observed| observed == address);
                let before = position.and_then(|position| self.before.get(position)).ok_or(PlanError::Unresolved)?;

                Ok(GuardedAccount {
                    address: *address,
                    owner: before.owner,
                    lamports: before.lamports,
                    data: &before.data,
                })
            })
            .collect::<Result<Vec<_>, PlanError>>()?;
        let memory = Memory::find(self.recipe.payers().fee, self.memory_id).ok_or(PlanError::NoMemoryAddress)?;
        let guard = Guard {
            recipe: self.recipe,
            outputs: &self.built.outputs,
            accounts: &accounts,
            rent_cap: self.rent_cap,
            memory,
        };

        guard.assertions().map_err(PlanError::Guard)
    }
}

fn count(len: usize) -> Result<u8, PlanError> {
    u8::try_from(len).map_err(|_| PlanError::DoesNotFit { limit: crate::Limit::Instructions, used: len, max: 255 })
}

fn lighthouse_instruction(instruction: &LighthouseInstruction) -> Instruction {
    Instruction {
        program: LIGHTHOUSE_PROGRAM,
        accounts: instruction
            .accounts()
            .iter()
            .map(|meta| AccountMeta { address: meta.address, role: meta.role })
            .collect(),
        data: instruction.data().to_vec(),
    }
}
