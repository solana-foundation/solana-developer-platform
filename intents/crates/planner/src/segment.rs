//! Plans one intent's segment of the transaction: `verify_intent` when the intent keeps it, then
//! the built instructions. Each simulation runs the earlier segments first, so a builder, the
//! rendered values, and the checks read the state after them.

use sha2::{Digest as _, Sha256};

use sdp_intents_engine::{Chain, Payers, Recipe, Resolution};
use sdp_intents_spec::builder::StagedResult;
use sdp_intents_spec::{Address, RecipeKind};

use crate::plan::{Built, PlannedIntent};
use crate::registry::VerifyIntent;
use crate::render::Column;
use crate::values::Values;
use crate::verify::{Snapshot, Verification};
use crate::{
    Account, Digests, Instruction, IntentDocuments, PlanError, RequiredSignature, Simulation, SimulationResult,
    Transaction,
};

/// A builder asks for accounts in at most 4 rounds.
const MAX_BUILDER_SIMULATIONS: usize = 4;

/// The segments before this one: their instructions, the fee of their simulation, and the chain
/// after them.
pub(crate) struct Earlier<'e, C> {
    pub(crate) instructions: &'e [Instruction],
    pub(crate) fee: u64,
    pub(crate) chain: &'e C,
}

pub(crate) enum SegmentStep {
    Fetch(Vec<Address>),
    Simulate(Simulation),
    Planned(Box<Segment>),
}

/// A planned segment, and the simulation of the transaction up to its end.
pub(crate) struct Segment {
    pub(crate) intent: PlannedIntent,
    /// The intent's part of the plan message.
    pub(crate) message: String,
    pub(crate) verify: Option<Instruction>,
    pub(crate) built: Vec<Instruction>,
    pub(crate) signatures: Vec<RequiredSignature>,
    /// The accounts that the segment can change, and their state after it, in the same order.
    pub(crate) observed: Vec<Address>,
    pub(crate) after: Vec<Option<Account>>,
    pub(crate) fee: u64,
    pub(crate) units_consumed: u64,
    pub(crate) loaded_accounts_data_size: Option<u32>,
}

pub(crate) struct SegmentPlanner<'a> {
    recipe: Recipe<'a>,
    intent: &'a [u8],
    digests: Digests,
    priority_fee_lamports: u64,
    /// The account that pays a builder simulation's fee and scratch rent.
    pub(crate) funder: Address,
    scratch: Address,
    extra_accounts: Vec<Address>,
    builder_simulations: usize,
    state: State,
}

enum State {
    Resolving,
    Building,
    /// A simulation of a call to `builder` has no answer yet.
    AwaitingBuilder {
        builder: Address,
    },
    Built(Built),
    AwaitingVerification(Box<Verifying>),
    Planned(Box<Segment>),
    Finished,
}

/// The segment, simulated after the earlier ones, with what the plan needs once the simulation
/// passes.
struct Verifying {
    built: Built,
    verify: Option<Instruction>,
    earlier_fee: u64,
    /// The fee of the transaction up to this segment, for a simulation that reports none.
    estimated_fee: u64,
    observe: Vec<Address>,
    before: Vec<Account>,
    guarantees: Vec<String>,
    message: String,
    display: String,
    signatures: Vec<RequiredSignature>,
}

impl<'a> SegmentPlanner<'a> {
    pub(crate) fn new(
        documents: IntentDocuments<'a>,
        payers: Payers<'a>,
        priority_fee_lamports: u64,
        scratch: Address,
    ) -> Result<Self, PlanError> {
        let recipe = Recipe::parse(documents.interface, documents.implementation, documents.intent, payers)?;

        if recipe.intent().options()?.assertions {
            return Err(PlanError::Unavailable("assertions"));
        }

        let digests = Digests {
            interface: Sha256::digest(documents.interface).into(),
            implementation: Sha256::digest(documents.implementation).into(),
        };
        let funder = *payers.fee;

        Ok(Self {
            recipe,
            intent: documents.intent,
            digests,
            priority_fee_lamports,
            funder,
            scratch,
            extra_accounts: Vec::new(),
            builder_simulations: 0,
            state: State::Resolving,
        })
    }

    pub(crate) fn next<C: Chain>(&mut self, earlier: &Earlier<'_, C>) -> Result<SegmentStep, PlanError> {
        match core::mem::replace(&mut self.state, State::Finished) {
            State::Resolving => self.resolve(earlier),
            State::Building => self.simulate_builder(earlier),
            State::Built(built) => self.simulate_segment(built, earlier),
            State::Planned(segment) => Ok(SegmentStep::Planned(segment)),
            awaiting @ (State::AwaitingBuilder { .. } | State::AwaitingVerification(_)) => {
                self.state = awaiting;
                Err(PlanError::OutOfOrder)
            }
            State::Finished => Err(PlanError::OutOfOrder),
        }
    }

    pub(crate) fn simulated(&mut self, result: SimulationResult) -> Result<(), PlanError> {
        match core::mem::replace(&mut self.state, State::Finished) {
            State::AwaitingBuilder { builder } => self.builder_result(builder, result),
            State::AwaitingVerification(verifying) => self.verified(*verifying, result),
            other => {
                self.state = other;
                Err(PlanError::OutOfOrder)
            }
        }
    }

    fn resolve<C: Chain>(&mut self, earlier: &Earlier<'_, C>) -> Result<SegmentStep, PlanError> {
        if let Resolution::Missing(missing) = self.recipe.resolve(earlier.chain)? {
            let addresses = missing.addresses().copied().collect();
            self.state = State::Resolving;

            return Ok(SegmentStep::Fetch(addresses));
        }

        match self.recipe.implementation().recipe()? {
            RecipeKind::Static => self.simulate_segment(Built::from_static(&self.recipe, earlier.chain)?, earlier),
            RecipeKind::Program => self.simulate_builder(earlier),
            RecipeKind::Remote => Err(PlanError::RemoteRecipe),
        }
    }

    fn simulate_builder<C: Chain>(&mut self, earlier: &Earlier<'_, C>) -> Result<SegmentStep, PlanError> {
        if self.builder_simulations == MAX_BUILDER_SIMULATIONS {
            return Err(PlanError::TooManyRounds);
        }

        let call = self.recipe.builder_call(earlier.chain, &self.extra_accounts)?;
        let builder = *call.program;
        let simulation = Simulation::staged(&call, earlier.instructions, self.funder, self.scratch)?;

        self.builder_simulations = self.builder_simulations.saturating_add(1);
        self.state = State::AwaitingBuilder { builder };

        Ok(SegmentStep::Simulate(simulation))
    }

    fn builder_result(&mut self, builder: Address, result: SimulationResult) -> Result<(), PlanError> {
        if let Some(error) = result.error {
            return Err(PlanError::Simulation { error, logs: result.logs });
        }

        let return_data =
            result.return_data.filter(|data| data.program == builder).ok_or(PlanError::NoBuilderResult)?;
        let scratch = result.accounts.into_iter().next().flatten().ok_or(PlanError::NoScratch)?;

        match StagedResult::parse(&return_data.data, &scratch.data)? {
            StagedResult::Ready(ready) => self.state = State::Built(Built::from_ready(&self.recipe, &ready)?),
            StagedResult::MoreAccounts(addresses) => {
                self.extra_accounts.extend_from_slice(addresses);
                self.state = State::Building;
            }
            StagedResult::Refused(refused) => {
                let text = |bytes: &[u8]| String::from_utf8_lossy(bytes).into_owned();

                return Err(PlanError::Refused { code: text(refused.code), message: text(refused.message) });
            }
        }

        Ok(())
    }

    /// Renders what needs account data, then simulates the transaction up to the end of this
    /// segment. The fee payer and the segment's writable accounts are snapshot first, because only
    /// they can change.
    fn simulate_segment<C: Chain>(&mut self, built: Built, earlier: &Earlier<'_, C>) -> Result<SegmentStep, PlanError> {
        if built.instructions.is_empty() {
            return Err(PlanError::NoInstructions);
        }

        let fee_payer = *self.recipe.payers().fee;
        let segment = Transaction::unbudgeted(fee_payer, built.instructions.clone());
        let observe = segment.writable_accounts();
        let values = Values { recipe: &self.recipe, chain: earlier.chain, outputs: &built.outputs };

        let missing = observe.iter().chain(&values.amount_mints()?).fold(Vec::new(), |mut missing, address| {
            if earlier.chain.account(address).is_none() && !missing.contains(address) {
                missing.push(*address);
            }

            missing
        });

        if !missing.is_empty() {
            self.state = State::Built(built);
            return Ok(SegmentStep::Fetch(missing));
        }

        let guarantees = values.guarantees()?;
        let builder = self.builder();
        let message = values.message(&guarantees, &self.digests, builder.as_ref())?;
        let display = values.render(self.recipe.interface().display()?, Column::Display)?;
        let signatures = values.signatures(&segment, &built)?;
        let before = observe.iter().map(|address| snapshot_of(earlier.chain, address)).collect();
        let verify = self.verify_instruction(&built)?;

        let instructions = earlier.instructions.iter().chain(&verify).chain(&built.instructions).cloned().collect();
        let transaction = Transaction {
            priority_fee_lamports: self.priority_fee_lamports,
            ..Transaction::unbudgeted(fee_payer, instructions)
        };
        transaction.check_fit()?;

        let estimated_fee = transaction.fee();
        let simulation = Simulation { transaction, observe: observe.clone() };
        let verifying = Verifying {
            built,
            verify,
            earlier_fee: earlier.fee,
            estimated_fee,
            observe,
            before,
            guarantees,
            message,
            display,
            signatures,
        };
        self.state = State::AwaitingVerification(Box::new(verifying));

        Ok(SegmentStep::Simulate(simulation))
    }

    /// `verify_intent` for the intent, unless the intent turns it off. A builder's roles come from
    /// its instructions, and a static recipe has none.
    fn verify_instruction(&self, built: &Built) -> Result<Option<Instruction>, PlanError> {
        if !self.recipe.intent().options()?.verify_intent {
            return Ok(None);
        }

        let builder_roles = match self.recipe.implementation().recipe()? {
            RecipeKind::Program => built.roles(),
            RecipeKind::Static | RecipeKind::Remote => Vec::new(),
        };
        let verify = VerifyIntent { intent: self.intent, extra_accounts: &self.extra_accounts, builder_roles };

        verify.instruction(&self.recipe).map(Some)
    }

    fn verified(&mut self, verifying: Verifying, result: SimulationResult) -> Result<(), PlanError> {
        if let Some(error) = result.error {
            return Err(PlanError::Simulation { error, logs: result.logs });
        }

        if result.accounts.len() != verifying.observe.len() {
            return Err(PlanError::NoAccounts);
        }

        let snapshots: Vec<Snapshot> = verifying
            .observe
            .iter()
            .zip(verifying.before)
            .zip(&result.accounts)
            .map(|((address, before), after)| Snapshot {
                address: *address,
                before,
                after: after.clone().unwrap_or_else(empty),
            })
            .collect();
        let fee = result.fee.unwrap_or(verifying.estimated_fee);

        Verification::new(
            &self.recipe,
            &verifying.built.outputs,
            &snapshots,
            &verifying.built.instructions,
            fee.saturating_sub(verifying.earlier_fee),
        )
        .check(&verifying.guarantees)?;

        let segment = Segment {
            message: verifying.message,
            intent: PlannedIntent {
                display: verifying.display,
                digests: self.digests,
                builder: self.builder(),
                outputs: verifying.built.outputs,
                builder_simulations: self.builder_simulations,
                verify: None,
                span: 0..0,
            },
            verify: verifying.verify,
            built: verifying.built.instructions,
            signatures: verifying.signatures,
            observed: verifying.observe,
            after: result.accounts,
            fee,
            units_consumed: result.units_consumed.ok_or(PlanError::NoUnits)?,
            loaded_accounts_data_size: result.loaded_accounts_data_size,
        };
        self.state = State::Planned(Box::new(segment));

        Ok(())
    }

    /// The builder program of a program recipe.
    fn builder(&self) -> Option<Address> {
        let implementation = self.recipe.implementation();
        let call = implementation.instructions().ok()?.first()?;

        (implementation.recipe().ok()? == RecipeKind::Program)
            .then(|| self.recipe.address(call.program).copied())
            .flatten()
    }
}

fn snapshot_of<C: Chain>(chain: &C, address: &Address) -> Account {
    chain.account(address).map_or_else(empty, |account| Account {
        owner: *account.owner,
        lamports: account.lamports,
        data: account.data.to_vec(),
    })
}

fn empty() -> Account {
    Account { owner: Address::default(), lamports: 0, data: Vec::new() }
}
