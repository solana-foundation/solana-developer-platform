//! Plans one intent's segment of the transaction. Each simulation runs the earlier segments first,
//! so a builder, the rendered values, and the checks read the state after them.
//!
//! A segment takes one simulation of the whole segment: `verify_intent`, the Lighthouse instructions
//! (`onchain.rs`), and the built instructions. Its onchain checks hold a placeholder rent cap,
//! because only the simulation shows the rent. The planner checks the postconditions and the payer
//! rules against it, then builds the onchain checks again with the rent that it measured. The
//! landed transaction differs from the simulated one only in that number, and a smaller cap that
//! the rent fits passes the same way.

use sha2::{Digest as _, Sha256};

use sdp_intents_engine::{Chain, Payers, Recipe, Resolution};
use sdp_intents_spec::builder::StagedResult;
use sdp_intents_spec::{Address, RecipeKind};

use crate::onchain::{OnchainChecks, OnchainInputs, PLACEHOLDER_RENT_CAP};
use crate::plan::{builder_program, with_rent_cap, Built, PlannedIntent};
use crate::remote::{self, RemoteAnswer, RemoteCall};
use crate::render::Column;
use crate::values::Values;
use crate::verify::{rent_cap, Snapshot, Verification};
use crate::{
    Account, Digests, FixedMessage, FrozenTransaction, Instruction, IntentDocuments, PlanError, RequiredSignature,
    Simulation, SimulationResult, Transaction,
};

/// `SysvarC1ock11111111111111111111111111111111`.
const CLOCK_SYSVAR: Address = Address([
    6, 167, 213, 23, 24, 199, 116, 201, 40, 86, 99, 152, 105, 29, 94, 182, 139, 94, 184, 163, 155, 75, 109, 92, 115,
    85, 91, 33, 0, 0, 0, 0,
]);

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
    Call(RemoteCall),
    Planned(Box<Segment>),
}

/// A planned segment, and the simulation of the transaction up to its end.
pub(crate) struct Segment {
    pub(crate) intent: PlannedIntent,
    /// The intent's part of the plan message.
    pub(crate) message: String,
    pub(crate) onchain: OnchainChecks,
    pub(crate) built: Vec<Instruction>,
    pub(crate) frozen: Option<FrozenTransaction>,
    pub(crate) signatures: Vec<RequiredSignature>,
    /// The accounts that the segment can change, and their state after it, in the same order.
    pub(crate) observed: Vec<Address>,
    pub(crate) after: Vec<Option<Account>>,
    pub(crate) fee: u64,
    pub(crate) units_consumed: u64,
    /// The units of each top-level instruction of the simulation, which ran the transaction so far.
    pub(crate) units_by_instruction: Vec<Option<u64>>,
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
    /// The remote endpoint has no answer yet.
    AwaitingRemote,
    Built(Box<Built>),
    AwaitingChecks(Box<Checking>),
    Planned(Box<Segment>),
    Finished,
}

/// The segment, simulated after the earlier segments, with what the plan needs once the simulation
/// passes.
struct Checking {
    built: Built,
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
            State::Built(built) => self.simulate_segment(*built, earlier),
            State::Planned(segment) => Ok(SegmentStep::Planned(segment)),
            awaiting @ (State::AwaitingBuilder { .. } | State::AwaitingChecks(_) | State::AwaitingRemote) => {
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
            other => {
                self.state = other;
                Err(PlanError::OutOfOrder)
            }
        }
    }

    pub(crate) fn called(&mut self, answer: RemoteAnswer) -> Result<(), PlanError> {
        match core::mem::replace(&mut self.state, State::Finished) {
            State::AwaitingRemote => {
                let built = match self.recipe.implementation().recipe()? {
                    RecipeKind::RemoteTransaction => {
                        Built::from_frozen(&self.recipe, answer, self.priority_fee_lamports)?
                    }
                    _ => Built::from_remote(&self.recipe, answer)?,
                };
                self.state = State::Built(Box::new(built));
                Ok(())
            }
            other => {
                self.state = other;
                Err(PlanError::OutOfOrder)
            }
        }
    }

    /// A remote segment's guarantees hold only when Lighthouse asserts them, unless the intent turns
    /// every onchain check off and trusts the endpoint.
    fn call_remote(&mut self) -> Result<SegmentStep, PlanError> {
        let options = self.recipe.intent().options()?;

        let remote_instructions = self.recipe.implementation().recipe()? == RecipeKind::Remote;

        if remote_instructions && options.verify_intent && !options.assertions {
            return Err(PlanError::RemoteNeedsAssertions);
        }

        self.state = State::AwaitingRemote;

        Ok(SegmentStep::Call(remote::call(&self.recipe, self.priority_fee_lamports)?))
    }

    /// A fetch that the recipe needs also asks for every account that the segment names and that
    /// the recipe already resolved, so that a static recipe's accounts arrive in one call.
    fn resolve<C: Chain>(&mut self, earlier: &Earlier<'_, C>) -> Result<SegmentStep, PlanError> {
        if let Resolution::Missing(missing) = self.recipe.resolve(earlier.chain)? {
            let needed: Vec<Address> = missing.addresses().copied().collect();
            let known = self.known_accounts()?;
            let addresses = needed.into_iter().chain(known).fold(Vec::new(), |mut addresses, address| {
                if earlier.chain.account(&address).is_none() && !addresses.contains(&address) {
                    addresses.push(address);
                }

                addresses
            });
            self.state = State::Resolving;

            return Ok(SegmentStep::Fetch(addresses));
        }

        match self.recipe.implementation().recipe()? {
            RecipeKind::Static => self.simulate_segment(Built::from_static(&self.recipe, earlier.chain)?, earlier),
            RecipeKind::Program => self.simulate_builder(earlier),
            RecipeKind::Remote | RecipeKind::RemoteTransaction => self.call_remote(),
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
            StagedResult::Ready(ready) => self.state = State::Built(Box::new(Built::from_ready(&self.recipe, &ready)?)),
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

    /// Renders what needs account data, then simulates the segment after the earlier segments. The
    /// fee payer and the segment's writable accounts are snapshot first, because only they can
    /// change.
    fn simulate_segment<C: Chain>(&mut self, built: Built, earlier: &Earlier<'_, C>) -> Result<SegmentStep, PlanError> {
        if built.instructions.is_empty() {
            return Err(PlanError::NoInstructions);
        }

        let fee_payer = *self.recipe.payers().fee;
        let segment = Transaction::unbudgeted(fee_payer, built.instructions.clone());
        let observe = segment.writable_accounts();
        let values = Values { recipe: &self.recipe, chain: earlier.chain, outputs: &built.outputs };

        let missing = observe.iter().chain(&values.message_accounts()?).fold(Vec::new(), |mut missing, address| {
            if earlier.chain.account(address).is_none() && !missing.contains(address) {
                missing.push(*address);
            }

            missing
        });

        if !missing.is_empty() {
            self.state = State::Built(Box::new(built));
            return Ok(SegmentStep::Fetch(missing));
        }

        let guarantees = values.guarantees()?;
        let message = values.message()?;
        let display = values.render(self.recipe.interface().display()?, Column::Display)?;
        let signatures = values.signatures(&segment, &built)?;
        let before: Vec<Account> = observe.iter().map(|address| snapshot_of(earlier.chain, address)).collect();
        let onchain = self.onchain_checks(&built, &observe, &before, PLACEHOLDER_RENT_CAP)?;

        let instructions = earlier
            .instructions
            .iter()
            .chain(&onchain.verify)
            .chain(&onchain.snapshots)
            .chain(&built.instructions)
            .chain(&onchain.checks);
        let transaction = match &built.frozen {
            Some(frozen) => frozen.transaction.clone(),
            None => self.transaction(instructions),
        };
        let fixed = built
            .frozen
            .as_ref()
            .map(|frozen| FixedMessage { bytes: frozen.message.clone(), lookup_tables: frozen.lookup_tables.clone() });
        transaction.check_fit()?;

        let checking = Checking {
            estimated_fee: transaction.fee(),
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

        Ok(SegmentStep::Simulate(Simulation { transaction, observe, fixed }))
    }

    /// Checks the postconditions and the payer rules, then builds the onchain checks with the rent
    /// cap that the simulation measures.
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
        check_provider_signers(&self.recipe, &checking.built, &snapshots)?;

        let rent_cap = rent_cap(&snapshots);
        let message = with_rent_cap(&checking.message, rent_cap);
        let onchain = self.onchain_checks(&checking.built, &checking.observe, &checking.before, rent_cap)?;

        self.state = State::Planned(Box::new(self.segment(checking, onchain, message, result)?));

        Ok(())
    }

    fn onchain_checks(
        &self,
        built: &Built,
        observed: &[Address],
        before: &[Account],
        rent_cap: u64,
    ) -> Result<OnchainChecks, PlanError> {
        let options = self.recipe.intent().options()?;

        if !options.verify_intent && !options.assertions {
            return Ok(OnchainChecks::default());
        }

        let inputs = OnchainInputs {
            recipe: &self.recipe,
            intent: self.intent,
            built,
            extra_accounts: &self.extra_accounts,
            observed,
            before,
            rent_cap,
            memory_id: self.memory_id,
        };

        inputs.checks()
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
            frozen: checking.built.frozen,
            built: checking.built.instructions,
            signatures: checking.signatures,
            observed: checking.observe,
            after: result.accounts,
            fee: result.fee.unwrap_or(checking.estimated_fee),
            units_consumed: result.units_consumed.ok_or(PlanError::NoUnits)?,
            units_by_instruction: crate::simulation::units_by_instruction(&result.logs),
            loaded_accounts_data_size: result.loaded_accounts_data_size,
        })
    }

    fn transaction<'i>(&self, instructions: impl Iterator<Item = &'i Instruction>) -> Transaction {
        Transaction {
            priority_fee_lamports: self.priority_fee_lamports,
            ..Transaction::unbudgeted(*self.recipe.payers().fee, instructions.cloned().collect())
        }
    }

    /// The payers, each account of the implementation that resolved, the mints and organizations that the
    /// message reads, the segment's Lighthouse memory, and the clock, which every simulation reads.
    fn known_accounts(&self) -> Result<Vec<Address>, PlanError> {
        let payers = self.recipe.payers();
        let table_len = self.recipe.implementation().accounts()?.len();
        let resolved = (0u8..).take(table_len).filter_map(|account| self.recipe.address(account).copied());
        let values = Values { recipe: &self.recipe, chain: &crate::AccountMap::default(), outputs: &[] };
        let memory = sdp_intents_lighthouse::Memory::find(payers.fee, self.memory_id).map(|memory| memory.address);

        Ok([*payers.fee, *payers.rent]
            .into_iter()
            .chain(resolved)
            .chain(values.input_mints()?)
            .chain(values.publishers())
            .chain(memory)
            .chain([CLOCK_SYSVAR])
            .collect())
    }

    /// The genesis hash of the implementation's cluster.
    pub(crate) fn cluster(&self) -> &Address {
        self.recipe.implementation().cluster()
    }

    /// The builder program of a program recipe.
    fn builder(&self) -> Option<Address> {
        builder_program(&self.recipe)
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
/// Each account that a provider signed for is one that the implementation lists, or one that the
/// transaction creates, which holds nothing before it.
fn check_provider_signers(recipe: &Recipe<'_>, built: &Built, snapshots: &[Snapshot]) -> Result<(), PlanError> {
    if built.frozen.is_none() {
        return Ok(());
    }

    let listed = remote::implementation_signers(recipe)?;
    let created = |address: &Address| {
        snapshots.iter().any(|snapshot| {
            snapshot.address == *address && snapshot.before.lamports == 0 && snapshot.after.lamports > 0
        })
    };

    match built.signers.iter().find(|signer| !listed.contains(signer) && !created(signer)) {
        Some(signer) => Err(PlanError::ProviderSigner(*signer)),
        None => Ok(()),
    }
}

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
