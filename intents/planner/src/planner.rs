use sha2::{Digest as _, Sha256};

use sdp_intents_engine::{Chain, Recipe, Resolution};
use sdp_intents_spec::builder::StagedResult;
use sdp_intents_spec::{Address, RecipeKind};

use crate::plan::Built;
use crate::render::Column;
use crate::values::Values;
use crate::verify::{Snapshot, Verification};
use crate::{Account, Budget, Digests, Plan, PlanError, RequiredSignature, Simulation, SimulationResult, Transaction};

/// A builder asks for accounts in at most 4 rounds.
const MAX_BUILDER_SIMULATIONS: usize = 4;

/// What the caller does next for the planner.
#[derive(Debug)]
pub enum Step {
    /// Fetch these accounts, such as with one `getMultipleAccounts`, then call `next` again.
    Fetch(Vec<Address>),
    /// Simulate this transaction and pass the result to `simulated`, then call `next` again.
    Simulate(Simulation),
    Done(Box<Plan>),
}

/// `prepare` for one intent, with no IO. Each `next` returns the fetch or the simulation that the
/// plan needs, and the caller answers it.
pub struct Planner<'a> {
    recipe: Recipe<'a>,
    digests: Digests,
    funder: Address,
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
    Planned(Box<Plan>),
    Finished,
}

/// The final transaction, simulated, with what the plan needs once the simulation passes.
struct Verifying {
    built: Built,
    transaction: Transaction,
    observe: Vec<Address>,
    before: Vec<Account>,
    guarantees: Vec<String>,
    message: String,
    display: String,
    signatures: Vec<RequiredSignature>,
}

impl<'a> Planner<'a> {
    /// `scratch` is any address that holds no account, where a builder simulation writes its result.
    /// A fresh random address keeps others from creating an account there first.
    ///
    /// The intent must turn off `assertions` and `verifyIntent`. Prepare builds neither the
    /// Lighthouse instructions nor `verify_intent` yet, and it refuses to drop a check that the
    /// intent asks for. Without them, the postconditions hold only in the simulation.
    pub fn new(
        interface: &'a [u8],
        implementation: &'a [u8],
        intent: &'a [u8],
        scratch: Address,
    ) -> Result<Self, PlanError> {
        let recipe = Recipe::parse(interface, implementation, intent)?;
        let options = recipe.intent().options()?;

        if options.assertions {
            return Err(PlanError::Unavailable("assertions"));
        }

        if options.verify_intent {
            return Err(PlanError::Unavailable("verifyIntent"));
        }

        let digests = Digests {
            interface: Sha256::digest(interface).into(),
            implementation: Sha256::digest(implementation).into(),
        };
        let funder = *recipe.intent().fee_payer();

        Ok(Self {
            recipe,
            digests,
            funder,
            scratch,
            extra_accounts: Vec::new(),
            builder_simulations: 0,
            state: State::Resolving,
        })
    }

    /// The account that pays a builder simulation's fee and scratch rent. It defaults to the fee
    /// payer.
    pub fn with_funder(mut self, funder: Address) -> Self {
        self.funder = funder;
        self
    }

    pub fn next<C: Chain>(&mut self, chain: &C) -> Result<Step, PlanError> {
        match core::mem::replace(&mut self.state, State::Finished) {
            State::Resolving => self.resolve(chain),
            State::Building => self.simulate_builder(chain),
            State::Built(built) => self.simulate_final(built, chain),
            State::Planned(plan) => Ok(Step::Done(plan)),
            awaiting @ (State::AwaitingBuilder { .. } | State::AwaitingVerification(_)) => {
                self.state = awaiting;
                Err(PlanError::OutOfOrder)
            }
            State::Finished => Err(PlanError::OutOfOrder),
        }
    }

    /// Reads the result of the simulation that `next` asked for.
    pub fn simulated(&mut self, result: SimulationResult) -> Result<(), PlanError> {
        match core::mem::replace(&mut self.state, State::Finished) {
            State::AwaitingBuilder { builder } => self.builder_result(builder, result),
            State::AwaitingVerification(verifying) => self.verified(*verifying, result),
            other => {
                self.state = other;
                Err(PlanError::OutOfOrder)
            }
        }
    }

    fn resolve<C: Chain>(&mut self, chain: &C) -> Result<Step, PlanError> {
        if let Resolution::Missing(missing) = self.recipe.resolve(chain)? {
            let addresses = missing.addresses().copied().collect();
            self.state = State::Resolving;

            return Ok(Step::Fetch(addresses));
        }

        match self.recipe.implementation().recipe()? {
            RecipeKind::Static => self.simulate_final(Built::from_static(&self.recipe, chain)?, chain),
            RecipeKind::Program => self.simulate_builder(chain),
            RecipeKind::Remote => Err(PlanError::RemoteRecipe),
        }
    }

    fn simulate_builder<C: Chain>(&mut self, chain: &C) -> Result<Step, PlanError> {
        if self.builder_simulations == MAX_BUILDER_SIMULATIONS {
            return Err(PlanError::TooManyRounds);
        }

        let call = self.recipe.builder_call(chain, &self.extra_accounts)?;
        let builder = *call.program;
        let simulation = Simulation::staged(&call, self.funder, self.scratch)?;

        self.builder_simulations = self.builder_simulations.saturating_add(1);
        self.state = State::AwaitingBuilder { builder };

        Ok(Step::Simulate(simulation))
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

    /// Renders what needs account data, then simulates the final transaction. The fee payer and
    /// the writable accounts are snapshot first, because only they can change.
    fn simulate_final<C: Chain>(&mut self, built: Built, chain: &C) -> Result<Step, PlanError> {
        let intent = self.recipe.intent();
        let transaction = Transaction {
            fee_payer: *intent.fee_payer(),
            instructions: built.instructions.clone(),
            budget: Budget::MAXIMUM,
            priority_fee_lamports: intent.priority_fee_lamports(),
        };
        let observe = transaction.writable_accounts();
        let values = Values { recipe: &self.recipe, chain, outputs: &built.outputs };

        let missing = observe.iter().chain(&values.amount_mints()?).fold(Vec::new(), |mut missing, address| {
            if chain.account(address).is_none() && !missing.contains(address) {
                missing.push(*address);
            }

            missing
        });

        if !missing.is_empty() {
            self.state = State::Built(built);
            return Ok(Step::Fetch(missing));
        }

        let guarantees = values.guarantees()?;
        let builder = self.builder();
        let message = values.message(&guarantees, &self.digests, builder.as_ref())?;
        let display = values.render(self.recipe.interface().display()?, Column::Display)?;
        let signatures = values.signatures(&transaction, &built)?;
        let before = observe.iter().map(|address| snapshot_of(chain, address)).collect();

        let simulation = Simulation { transaction: transaction.clone(), observe: observe.clone() };
        let verifying = Verifying { built, transaction, observe, before, guarantees, message, display, signatures };
        self.state = State::AwaitingVerification(Box::new(verifying));

        Ok(Step::Simulate(simulation))
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
            .zip(result.accounts)
            .map(|((address, before), after)| Snapshot {
                address: *address,
                before,
                after: after.unwrap_or_else(empty),
            })
            .collect();
        let fee = result.fee.unwrap_or_else(|| verifying.transaction.fee());

        Verification::new(&self.recipe, &verifying.built.outputs, &snapshots, &verifying.transaction.instructions, fee)
            .check(&verifying.guarantees)?;

        let units_consumed = result.units_consumed.ok_or(PlanError::NoUnits)?;
        let budget = Budget::measured(units_consumed, result.loaded_accounts_data_size);
        let plan = Plan {
            message: verifying.message,
            display: verifying.display,
            digests: self.digests,
            builder: self.builder(),
            transaction: Transaction { budget, ..verifying.transaction },
            signatures: verifying.signatures,
            outputs: verifying.built.outputs,
            builder_simulations: self.builder_simulations,
            units_consumed,
        };
        self.state = State::Planned(Box::new(plan));

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

#[cfg(test)]
mod tests {
    use sdp_intents_spec::AccountRole;

    use super::*;
    use crate::test_support::*;
    use crate::{AccountMap, AccountMeta, SignerRole};

    const FEE_PAYER: &str = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";
    const FROM: &str = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const TO: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const TOKEN_2022_PROGRAM: &str = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
    const ATA_RENT: u64 = 2_039_280;
    const SOL: u64 = 1_000_000_000;

    fn mint(owner: &str) -> Account {
        Account { owner: account(owner), lamports: 1_461_600, data: [&[0; 44][..], &[6], &[0; 37]].concat() }
    }

    fn usdc(owner: &str, amount: u64) -> Account {
        Account {
            owner: account(TOKEN_PROGRAM),
            lamports: ATA_RENT,
            data: token_account(account(USDC), account(owner), amount),
        }
    }

    fn wallet(lamports: u64) -> Account {
        Account { owner: Address::default(), lamports, data: Vec::new() }
    }

    fn fetch(
        planner: &mut Planner<'_>,
        accounts: &mut AccountMap,
        answer: impl Fn(&Address) -> Option<Account>,
    ) -> Step {
        let Ok(Step::Fetch(addresses)) = planner.next(accounts) else { panic!("the planner does not fetch") };
        let fetched = addresses.iter().map(&answer).collect();
        accounts.insert_fetched(&addresses, fetched);

        planner.next(accounts).unwrap()
    }

    fn simulation(step: Step) -> Simulation {
        let Step::Simulate(simulation) = step else { panic!("the step is not a simulation") };

        simulation
    }

    /// The SPL transfer up to its final simulation. The observed accounts are the fee payer, the
    /// destination ATA, and the source ATA, in that order.
    fn spl_final_simulation(planner: &mut Planner<'_>, accounts: &mut AccountMap) -> Simulation {
        let step = fetch(planner, accounts, |_| Some(mint(TOKEN_PROGRAM)));
        assert!(matches!(step, Step::Fetch(_)), "the planner fetches the writable accounts before the final run");

        let Step::Fetch(addresses) = step else { unreachable!() };
        let before = |address: &Address| match addresses.iter().position(|known| known == address) {
            Some(0) => Some(wallet(SOL)),
            Some(1) => None,
            _ => Some(usdc(FROM, 500_000_000)),
        };
        let fetched = addresses.iter().map(before).collect();
        accounts.insert_fetched(&addresses, fetched);

        simulation(planner.next(accounts).unwrap())
    }

    fn spl_result(source_after: u64, fee_payer_after: u64) -> SimulationResult {
        SimulationResult {
            accounts: vec![Some(wallet(fee_payer_after)), Some(usdc(TO, 100_000_000)), Some(usdc(FROM, source_after))],
            units_consumed: Some(30_000),
            ..SimulationResult::default()
        }
    }

    #[test]
    fn plans_a_static_transfer() {
        let documents = Compiled::spl_transfer();
        let mut planner =
            Planner::new(&documents.interface, &documents.implementation, &documents.intent, SCRATCH).unwrap();
        let mut accounts = AccountMap::default();

        let final_run = spl_final_simulation(&mut planner, &mut accounts);
        assert_eq!(final_run.observe.len(), 3);

        planner.simulated(spl_result(400_000_000, SOL - 15_000 - ATA_RENT)).unwrap();
        let Ok(Step::Done(plan)) = planner.next(&accounts) else { panic!("the plan is done") };

        assert!(plan.message.starts_with(&format!("sdp-intents/1: transfer 100 of {USDC} from {FROM} to {TO} | guarantees: {FROM} sends at most 100 of {USDC}; nothing else leaves {FROM} | interface: token.transfer@1.0.0 ")));
        assert_eq!(plan.display, format!("Send 100 {USDC} to 9WzD…AWWM"));
        assert_eq!(plan.transaction.budget.compute_unit_limit, 33_000);
        assert_eq!(plan.transaction.priority_fee_lamports, 5_000);
        assert_eq!(
            plan.signatures.iter().map(|signature| signature.role.clone()).collect::<Vec<_>>(),
            [SignerRole::FeePayer, SignerRole::Input("from".into())]
        );
    }

    #[test]
    fn a_broken_guarantee_fails_the_plan() {
        let documents = Compiled::spl_transfer();
        let mut planner =
            Planner::new(&documents.interface, &documents.implementation, &documents.intent, SCRATCH).unwrap();
        spl_final_simulation(&mut planner, &mut AccountMap::default());

        let failed = planner.simulated(spl_result(300_000_000, SOL - 15_000 - ATA_RENT));

        assert_eq!(failed, Err(PlanError::CheckFailed(format!("{FROM} sends at most 100 of {USDC}"))));
    }

    #[test]
    fn a_fee_payer_that_loses_more_than_the_fee_and_the_rent_fails_the_plan() {
        let documents = Compiled::spl_transfer();
        let mut planner =
            Planner::new(&documents.interface, &documents.implementation, &documents.intent, SCRATCH).unwrap();
        spl_final_simulation(&mut planner, &mut AccountMap::default());

        let failed = planner.simulated(spl_result(400_000_000, SOL / 2));

        assert!(
            failed.is_err_and(|error| matches!(error, PlanError::CheckFailed(check) if check.contains("fee payer")))
        );
    }

    #[test]
    fn an_intent_that_keeps_the_onchain_checks_is_refused() {
        let documents = Compiled::compile(
            include_str!("../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json"),
            &include_str!("../../fixtures/intents/spl-token-transfer.json").replace(r#""assertions": false, "#, ""),
        );

        let refused = Planner::new(&documents.interface, &documents.implementation, &documents.intent, SCRATCH);

        assert!(refused.is_err_and(|error| error == PlanError::Unavailable("assertions")));
    }

    fn builder_planner(documents: &Compiled) -> (Planner<'_>, AccountMap) {
        let mut planner =
            Planner::new(&documents.interface, &documents.implementation, &documents.intent, SCRATCH).unwrap();
        let mut accounts = AccountMap::default();
        let step = fetch(&mut planner, &mut accounts, |_| Some(mint(TOKEN_2022_PROGRAM)));
        assert!(matches!(step, Step::Simulate(_)));

        (planner, accounts)
    }

    #[test]
    fn a_builder_simulation_creates_scratch_first() {
        let documents = Compiled::token_2022_transfer();
        let mut planner =
            Planner::new(&documents.interface, &documents.implementation, &documents.intent, SCRATCH).unwrap();
        let simulation =
            simulation(fetch(&mut planner, &mut AccountMap::default(), |_| Some(mint(TOKEN_2022_PROGRAM))));
        let [create, call] = simulation.transaction.instructions.as_slice() else { panic!("two instructions") };

        assert_eq!(simulation.transaction.fee_payer, account(FEE_PAYER));
        assert_eq!(simulation.transaction.budget, Budget::MAXIMUM);
        assert_eq!(simulation.observe, [SCRATCH]);
        assert_eq!(create.accounts.get(1), Some(&AccountMeta { address: SCRATCH, role: AccountRole::WritableSigner }));
        assert_eq!(create.data.get(20..), Some(&BUILDER.0[..]));
        assert_eq!(call.program, BUILDER);
        assert_eq!(call.accounts.last(), Some(&AccountMeta { address: SCRATCH, role: AccountRole::Writable }));
    }

    #[test]
    fn more_accounts_run_another_round_and_the_placeholder_becomes_the_rent_payer() {
        let documents = Compiled::token_2022_transfer();
        let (mut planner, mut accounts) = builder_planner(&documents);
        let hook = Address([8; 32]);

        planner.simulated(more_accounts(&[hook])).unwrap();
        let second = simulation(planner.next(&accounts).unwrap());
        let call = second.transaction.instructions.get(1).unwrap();
        assert_eq!(call.accounts.get(5), Some(&AccountMeta { address: hook, role: AccountRole::Readonly }));

        planner.simulated(ready_with_rent_payer()).unwrap();
        let final_run = simulation(fetch(&mut planner, &mut accounts, |_| Some(wallet(SOL))));
        let transfer = final_run.transaction.instructions.first().unwrap();

        assert_eq!(transfer.accounts.first().map(|meta| meta.address), Some(account(FROM)));
    }

    #[test]
    fn a_refusal_and_a_failed_simulation_end_the_plan() {
        let documents = Compiled::token_2022_transfer();
        let (mut planner, _) = builder_planner(&documents);
        let refusal = planner.simulated(refused("nonTransferable", "the mint is non-transferable"));

        assert_eq!(
            refusal,
            Err(PlanError::Refused { code: "nonTransferable".into(), message: "the mint is non-transferable".into() })
        );

        let (mut planner, _) = builder_planner(&documents);
        let failed = SimulationResult { error: Some("InsufficientFunds".into()), ..SimulationResult::default() };

        assert!(planner.simulated(failed).is_err_and(|error| matches!(error, PlanError::Simulation { .. })));
    }

    #[test]
    fn a_builder_gets_four_rounds() {
        let documents = Compiled::token_2022_transfer();
        let (mut planner, accounts) = builder_planner(&documents);

        for round in 1u8..4 {
            planner.simulated(more_accounts(&[Address([round; 32])])).unwrap();
            simulation(planner.next(&accounts).unwrap());
        }

        planner.simulated(more_accounts(&[Address([9; 32])])).unwrap();

        assert!(planner.next(&accounts).is_err_and(|error| error == PlanError::TooManyRounds));
    }

    #[test]
    fn steps_run_in_order() {
        let documents = Compiled::token_2022_transfer();
        let mut planner =
            Planner::new(&documents.interface, &documents.implementation, &documents.intent, SCRATCH).unwrap();

        assert_eq!(planner.simulated(SimulationResult::default()), Err(PlanError::OutOfOrder));

        let (mut planner, accounts) = builder_planner(&documents);

        assert!(planner.next(&accounts).is_err_and(|error| error == PlanError::OutOfOrder));
    }
}
