//! Plans one intent's segment of the transaction. Each simulation runs the earlier segments first,
//! so a builder, the rendered values, and the checks read the state after them.
//!
//! A segment takes two simulations. The first runs the built instructions alone: the planner checks
//! the postconditions and the payer rules against it, and reads the rent cap from it. The second
//! runs the whole segment, with `verify_intent` and the Lighthouse instructions (`onchain.rs`). An
//! intent that turns both checks off needs only the first.

use sha2::{Digest as _, Sha256};

use sdp_intents_engine::{Chain, Payers, Recipe, Resolution};
use sdp_intents_spec::builder::StagedResult;
use sdp_intents_spec::{Address, RecipeKind};

use crate::onchain::{OnchainChecks, OnchainInputs};
use crate::plan::{Built, PlannedIntent};
use crate::render::Column;
use crate::values::Values;
use crate::verify::{rent_cap, Snapshot, Verification};
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
    pub(crate) onchain: OnchainChecks,
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
    memory_id: u8,
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
    AwaitingChecks(Box<Checking>),
    /// The simulation of the whole segment, which `next` returns.
    Onchain(Box<Onchain>),
    AwaitingOnchain(Box<Onchain>),
    Planned(Box<Segment>),
    Finished,
}

/// The built instructions, simulated after the earlier segments, with what the plan needs once the
/// simulation passes.
struct Checking {
    built: Built,
    earlier: Vec<Instruction>,
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

/// The whole segment, after the built instructions passed their checks.
struct Onchain {
    checking: Checking,
    onchain: OnchainChecks,
    message: String,
    simulation: Option<Simulation>,
}

impl<'a> SegmentPlanner<'a> {
    pub(crate) fn new(
        documents: IntentDocuments<'a>,
        payers: Payers<'a>,
        priority_fee_lamports: u64,
        memory_id: u8,
        scratch: Address,
    ) -> Result<Self, PlanError> {
        let recipe = Recipe::parse(documents.interface, documents.implementation, documents.intent, payers)?;
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
            memory_id,
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
            State::Built(built) => self.simulate_built(built, earlier),
            State::Onchain(mut onchain) => {
                let simulation = onchain.simulation.take().ok_or(PlanError::OutOfOrder)?;
                self.state = State::AwaitingOnchain(onchain);

                Ok(SegmentStep::Simulate(simulation))
            }
            State::Planned(segment) => Ok(SegmentStep::Planned(segment)),
            awaiting @ (State::AwaitingBuilder { .. } | State::AwaitingChecks(_) | State::AwaitingOnchain(_)) => {
                self.state = awaiting;
                Err(PlanError::OutOfOrder)
            }
            State::Finished => Err(PlanError::OutOfOrder),
        }
    }

    pub(crate) fn simulated(&mut self, result: SimulationResult) -> Result<(), PlanError> {
        match core::mem::replace(&mut self.state, State::Finished) {
            State::AwaitingBuilder { builder } => self.builder_result(builder, result),
            State::AwaitingChecks(checking) => self.checked(*checking, result),
            State::AwaitingOnchain(onchain) => self.verified_onchain(*onchain, result),
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
            RecipeKind::Static => self.simulate_built(Built::from_static(&self.recipe, earlier.chain)?, earlier),
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

    /// Renders what needs account data, then simulates the built instructions after the earlier
    /// segments. The fee payer and the segment's writable accounts are snapshot first, because only
    /// they can change.
    fn simulate_built<C: Chain>(&mut self, built: Built, earlier: &Earlier<'_, C>) -> Result<SegmentStep, PlanError> {
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

        let transaction = self.transaction(earlier.instructions.iter().chain(&built.instructions));
        transaction.check_fit()?;

        let checking = Checking {
            estimated_fee: transaction.fee(),
            earlier: earlier.instructions.to_vec(),
            earlier_fee: earlier.fee,
            built,
            observe: observe.clone(),
            before,
            guarantees,
            message,
            display,
            signatures,
        };
        self.state = State::AwaitingChecks(Box::new(checking));

        Ok(SegmentStep::Simulate(Simulation { transaction, observe }))
    }

    /// Checks the postconditions and the payer rules, then builds the onchain checks with the rent
    /// cap that the simulation gives.
    fn checked(&mut self, checking: Checking, result: SimulationResult) -> Result<(), PlanError> {
        let snapshots = snapshots(&checking, &result)?;
        let fee = result.fee.unwrap_or(checking.estimated_fee);

        Verification::new(
            &self.recipe,
            &checking.built.outputs,
            &snapshots,
            &checking.built.instructions,
            fee.saturating_sub(checking.earlier_fee),
        )
        .check(&checking.guarantees)?;

        let rent_cap = rent_cap(&snapshots);
        let message = format!("{} | rent cap {rent_cap} lamports", checking.message);
        let options = self.recipe.intent().options()?;

        if !options.verify_intent && !options.assertions {
            self.state = State::Planned(Box::new(self.segment(checking, OnchainChecks::default(), message, result)?));
            return Ok(());
        }

        let inputs = OnchainInputs {
            recipe: &self.recipe,
            intent: self.intent,
            built: &checking.built,
            extra_accounts: &self.extra_accounts,
            snapshots: &snapshots,
            rent_cap,
            memory_id: self.memory_id,
        };
        let onchain = inputs.checks()?;

        let instructions = checking
            .earlier
            .iter()
            .chain(&onchain.verify)
            .chain(&onchain.snapshots)
            .chain(&checking.built.instructions)
            .chain(&onchain.checks);
        let transaction = self.transaction(instructions);
        transaction.check_fit()?;

        let simulation = Simulation { transaction, observe: checking.observe.clone() };
        self.state = State::Onchain(Box::new(Onchain { checking, onchain, message, simulation: Some(simulation) }));

        Ok(())
    }

    /// The postconditions held in the first simulation, so this one only has to pass.
    fn verified_onchain(&mut self, onchain: Onchain, result: SimulationResult) -> Result<(), PlanError> {
        snapshots(&onchain.checking, &result)?;

        let segment = self.segment(onchain.checking, onchain.onchain, onchain.message, result)?;
        self.state = State::Planned(Box::new(segment));

        Ok(())
    }

    fn segment(
        &self,
        checking: Checking,
        onchain: OnchainChecks,
        message: String,
        result: SimulationResult,
    ) -> Result<Segment, PlanError> {
        Ok(Segment {
            message,
            intent: PlannedIntent {
                display: checking.display,
                digests: self.digests,
                builder: self.builder(),
                outputs: checking.built.outputs,
                builder_simulations: self.builder_simulations,
                verify: None,
                span: 0..0,
            },
            onchain,
            built: checking.built.instructions,
            signatures: checking.signatures,
            observed: checking.observe,
            after: result.accounts,
            fee: result.fee.unwrap_or(checking.estimated_fee),
            units_consumed: result.units_consumed.ok_or(PlanError::NoUnits)?,
            loaded_accounts_data_size: result.loaded_accounts_data_size,
        })
    }

    fn transaction<'i>(&self, instructions: impl Iterator<Item = &'i Instruction>) -> Transaction {
        Transaction {
            priority_fee_lamports: self.priority_fee_lamports,
            ..Transaction::unbudgeted(*self.recipe.payers().fee, instructions.cloned().collect())
        }
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

/// Each observed account before the simulation and after it.
fn snapshots(checking: &Checking, result: &SimulationResult) -> Result<Vec<Snapshot>, PlanError> {
    if let Some(error) = &result.error {
        return Err(PlanError::Simulation { error: error.clone(), logs: result.logs.clone() });
    }

    if result.accounts.len() != checking.observe.len() {
        return Err(PlanError::NoAccounts);
    }

    Ok(checking
        .observe
        .iter()
        .zip(&checking.before)
        .zip(&result.accounts)
        .map(|((address, before), after)| Snapshot {
            address: *address,
            before: before.clone(),
            after: after.clone().unwrap_or_else(empty),
        })
        .collect())
}

fn empty() -> Account {
    Account { owner: Address::default(), lamports: 0, data: Vec::new() }
}
