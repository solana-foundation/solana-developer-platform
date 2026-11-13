//! The plan of one or more intents. Each intent is one segment of the transaction, planned in
//! order, so each segment's simulations run the earlier segments first. The last simulation is the
//! whole transaction, and its compute units set the budget.

use sdp_intents_engine::{Chain, Payers};
use sdp_intents_spec::Address;

use crate::accounts::Overlay;
use crate::plan::{plan_message, PlannedIntent};
use crate::segment::{Earlier, Segment, SegmentPlanner, SegmentStep};
use crate::{AccountMap, Budget, Instruction, IntentDocuments, Plan, PlanError, RequiredSignature, Simulation};

/// What `prepare` plans: one or more intents, and the payers and priority fee of the transaction.
#[derive(Clone, Debug)]
pub struct PlanRequest<'a> {
    pub intents: Vec<IntentDocuments<'a>>,
    pub payers: Payers<'a>,
    pub priority_fee_lamports: u64,
}
use crate::{FrozenTransaction, RemoteAnswer, RemoteCall, SimulationResult, Transaction};

/// The longest off-chain message that a Ledger signs: one packet less the message header.
const MAX_MESSAGE_LEN: usize = 1_212;

/// What the caller does next for the planner.
#[derive(Debug)]
pub enum Step {
    /// Fetch these accounts, such as with one `getMultipleAccounts`, then call `next` again.
    Fetch(Vec<Address>),
    /// Simulate this transaction and pass the result to `simulated`, then call `next` again.
    Simulate(Simulation),
    /// Call a remote recipe's endpoint and pass its answer to `called`, then call `next` again.
    Call(RemoteCall),
    Done(Box<Plan>),
}

/// `prepare` with no IO. Each `next` returns the fetch or the simulation that the plan needs, and
/// the caller answers it.
pub struct Planner<'a> {
    segments: Vec<SegmentPlanner<'a>>,
    payers: Payers<'a>,
    priority_fee_lamports: u64,

    intents: Vec<PlannedIntent>,
    messages: Vec<String>,
    instructions: Vec<Instruction>,
    signatures: Vec<RequiredSignature>,
    after: AccountMap,
    last: Option<Measured>,
    frozen: Option<FrozenTransaction>,
}

/// The simulation of the transaction up to the end of the last planned segment.
#[derive(Clone, Copy)]
struct Measured {
    fee: u64,
    units_consumed: u64,
    loaded_accounts_data_size: Option<u32>,
}

impl<'a> Planner<'a> {
    /// `scratch` is any address that holds no account, where a builder simulation writes its result.
    /// A fresh random address keeps others from creating an account there first.
    ///
    pub fn new(request: &PlanRequest<'a>, scratch: Address) -> Result<Self, PlanError> {
        let segments = request
            .intents
            .iter()
            .zip(0u8..)
            .map(|(documents, memory_id)| {
                SegmentPlanner::new(*documents, request.payers, request.priority_fee_lamports, memory_id, scratch)
            })
            .collect::<Result<Vec<_>, _>>()?;

        if segments.is_empty() {
            return Err(PlanError::NoIntents);
        }

        Ok(Self {
            payers: request.payers,
            priority_fee_lamports: request.priority_fee_lamports,
            segments,
            intents: Vec::new(),
            messages: Vec::new(),
            instructions: Vec::new(),
            signatures: Vec::new(),
            after: AccountMap::default(),
            last: None,
            frozen: None,
        })
    }

    /// The account that pays a builder simulation's fee and scratch rent. It defaults to the fee
    /// payer.
    pub fn with_funder(mut self, funder: Address) -> Self {
        self.segments.iter_mut().for_each(|segment| segment.funder = funder);
        self
    }

    pub fn next<C: Chain>(&mut self, chain: &C) -> Result<Step, PlanError> {
        loop {
            let Some(segment) = self.segments.get_mut(self.intents.len()) else {
                return self.finish().map(|plan| Step::Done(Box::new(plan)));
            };

            let overlay = Overlay { after: &self.after, base: chain };
            let fee = self.last.map_or(0, |last| last.fee);
            let earlier = Earlier { instructions: &self.instructions, fee, chain: &overlay };

            match segment.next(&earlier)? {
                SegmentStep::Fetch(addresses) => return Ok(Step::Fetch(addresses)),
                SegmentStep::Simulate(simulation) => return Ok(Step::Simulate(simulation)),
                SegmentStep::Call(call) => return Ok(Step::Call(call)),
                SegmentStep::Planned(segment) => self.add(*segment),
            }
        }
    }

    /// Reads the answer of the remote endpoint that `next` asked for.
    pub fn called(&mut self, answer: RemoteAnswer) -> Result<(), PlanError> {
        self.segments.get_mut(self.intents.len()).ok_or(PlanError::OutOfOrder)?.called(answer)
    }

    /// Reads the result of the simulation that `next` asked for.
    pub fn simulated(&mut self, result: SimulationResult) -> Result<(), PlanError> {
        self.segments.get_mut(self.intents.len()).ok_or(PlanError::OutOfOrder)?.simulated(result)
    }

    /// Appends the segment's instructions, and keeps the state after it for the next segment.
    fn add(&mut self, segment: Segment) {
        let onchain = segment.onchain;
        let verify = onchain.verify.map(|verify| {
            self.instructions.push(verify);
            self.instructions.len().saturating_sub(1)
        });
        self.instructions.extend(onchain.snapshots);
        let start = self.instructions.len();
        self.instructions.extend(segment.built);
        let end = self.instructions.len();
        self.instructions.extend(onchain.checks);

        let new_signatures: Vec<_> = segment
            .signatures
            .into_iter()
            .filter(|signature| !self.signatures.iter().any(|known| known.address == signature.address))
            .collect();
        self.signatures.extend(new_signatures);

        self.after.insert_fetched(&segment.observed, segment.after);
        self.last = Some(Measured {
            fee: segment.fee,
            units_consumed: segment.units_consumed,
            loaded_accounts_data_size: segment.loaded_accounts_data_size,
        });
        self.frozen = self.frozen.take().or(segment.frozen);
        self.messages.push(segment.message);
        self.intents.push(PlannedIntent { verify, span: start..end, ..segment.intent });
    }

    /// The last simulation ran the whole transaction, so it measures the budget. A provider's
    /// transaction keeps its own budget and priority fee, and is the whole plan.
    fn finish(&mut self) -> Result<Plan, PlanError> {
        let last = self.last.take().ok_or(PlanError::OutOfOrder)?;
        let frozen = self.frozen.take();

        if frozen.is_some() && self.intents.len() > 1 {
            return Err(PlanError::RemoteTransaction(
                "a provider's transaction is the whole plan, with no other intent",
            ));
        }

        let transaction = match &frozen {
            Some(frozen) => frozen.transaction.clone(),
            None => Transaction {
                fee_payer: *self.payers.fee,
                instructions: core::mem::take(&mut self.instructions),
                budget: Budget::measured(last.units_consumed, last.loaded_accounts_data_size),
                priority_fee_lamports: self.priority_fee_lamports,
            },
        };

        let message =
            plan_message(self.payers, transaction.priority_fee_lamports, &core::mem::take(&mut self.messages));

        if message.len() > MAX_MESSAGE_LEN {
            return Err(PlanError::MessageTooLong { used: message.len(), max: MAX_MESSAGE_LEN });
        }

        Ok(Plan {
            message,
            intents: core::mem::take(&mut self.intents),
            transaction,
            signatures: core::mem::take(&mut self.signatures),
            units_consumed: last.units_consumed,
            frozen,
        })
    }
}

#[cfg(test)]
mod tests {
    use sdp_intents_lighthouse::LIGHTHOUSE_PROGRAM;
    use sdp_intents_spec::AccountRole;

    use super::*;
    use crate::test_support::*;
    use crate::{Account, AccountMap, AccountMeta, PlanRequest, SignerRole};

    const FEE_PAYER: &str = "5ZWj7a1f8tWkjBESHKgrLmXshuXxqeY9SYcfbshpAqPG";
    const FROM: &str = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    const TO: &str = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    const USDC: &str = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const ASSOCIATED_TOKEN: &str = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
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
        let mut planner = Planner::new(&request(&[&documents], 5_000), SCRATCH).unwrap();
        let mut accounts = chain();

        let final_run = spl_final_simulation(&mut planner, &mut accounts);
        assert_eq!(final_run.observe.len(), 3);

        planner.simulated(spl_result(400_000_000, SOL - 15_000 - ATA_RENT)).unwrap();
        let Ok(Step::Done(plan)) = planner.next(&accounts) else { panic!("the plan is done") };

        assert_eq!(
            plan.message,
            format!(
                "sdp-intents/1 || 1: transfer 100 of {USDC} from {FROM} to {TO} | interface: solana.org/token.transfer@1.0.0 | implementation: solana.org/spl-token-transfer@1.0.0 | tier 1 | onchain checks: none | rent cap 2039280 lamports || fee and rent payer {FEE_PAYER} | priority fee 5000 lamports"
            )
        );
        assert_eq!(plan.intents[0].display, format!("Send 100 {USDC} to 9WzD…AWWM"));
        assert_eq!(plan.transaction.budget.compute_unit_limit, 33_000);
        assert_eq!(plan.transaction.priority_fee_lamports, 5_000);
        assert_eq!(
            plan.signatures.iter().map(|signature| signature.role.clone()).collect::<Vec<_>>(),
            [SignerRole::FeePayer, SignerRole::Input("from".into())]
        );
    }

    /// The idempotent create names the rent payer and creates nothing, because the receiver's ATA
    /// exists.
    #[test]
    fn plans_a_transfer_to_an_existing_token_account() {
        let documents = Compiled::spl_transfer();
        let mut planner = Planner::new(&request(&[&documents], 5_000), SCRATCH).unwrap();
        let mut accounts = chain();

        let Step::Fetch(addresses) = fetch(&mut planner, &mut accounts, |_| Some(mint(TOKEN_PROGRAM))) else {
            panic!("the planner fetches the writable accounts")
        };
        let before = |address: &Address| match addresses.iter().position(|known| known == address) {
            Some(0) => Some(wallet(SOL)),
            Some(1) => Some(usdc(TO, 0)),
            _ => Some(usdc(FROM, 500_000_000)),
        };
        accounts.insert_fetched(&addresses, addresses.iter().map(before).collect());
        simulation(planner.next(&accounts).unwrap());

        planner.simulated(spl_result(400_000_000, SOL - 15_000)).unwrap();

        assert!(matches!(planner.next(&accounts), Ok(Step::Done(_))));
    }

    #[test]
    fn a_broken_guarantee_fails_the_plan() {
        let documents = Compiled::spl_transfer();
        let mut planner = Planner::new(&request(&[&documents], 5_000), SCRATCH).unwrap();
        spl_final_simulation(&mut planner, &mut chain());

        let failed = planner.simulated(spl_result(300_000_000, SOL - 15_000 - ATA_RENT));

        assert_eq!(failed, Err(PlanError::CheckFailed(format!("{FROM} sends at most 100 of {USDC}"))));
    }

    #[test]
    fn a_fee_payer_that_loses_more_than_the_fee_and_the_rent_fails_the_plan() {
        let documents = Compiled::spl_transfer();
        let mut planner = Planner::new(&request(&[&documents], 5_000), SCRATCH).unwrap();
        spl_final_simulation(&mut planner, &mut chain());

        let failed = planner.simulated(spl_result(400_000_000, SOL / 2));

        assert!(
            failed.is_err_and(|error| matches!(error, PlanError::CheckFailed(check) if check.contains("fee payer")))
        );
    }

    /// The sender's token account is the only guarded value, so the segment snapshots its amount
    /// and asserts the outflow around the two built instructions, in its one simulation. Rule 3
    /// adds three assertions on its authorities.
    #[test]
    fn assertions_guard_the_segment() {
        let documents = Compiled::compile(
            include_str!("../../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json"),
            &include_str!("../../../fixtures/intents/spl-token-transfer.json").replace(r#""assertions": false, "#, ""),
        );
        let mut planner = Planner::new(&request(&[&documents], 5_000), SCRATCH).unwrap();
        let mut accounts = chain();

        let guarded = spl_final_simulation(&mut planner, &mut accounts);
        let programs: Vec<_> = guarded.transaction.instructions.iter().map(|instruction| instruction.program).collect();
        assert_eq!(
            programs,
            [
                LIGHTHOUSE_PROGRAM,
                account(ASSOCIATED_TOKEN),
                account(TOKEN_PROGRAM),
                LIGHTHOUSE_PROGRAM,
                LIGHTHOUSE_PROGRAM,
                LIGHTHOUSE_PROGRAM,
                LIGHTHOUSE_PROGRAM,
                LIGHTHOUSE_PROGRAM
            ]
        );

        planner.simulated(spl_result(400_000_000, SOL - 15_000 - ATA_RENT)).unwrap();
        let Ok(Step::Done(plan)) = planner.next(&accounts) else { panic!("the plan is done") };

        assert_eq!(plan.intents[0].span, 1..3);
        assert_eq!(plan.transaction.instructions.len(), 8);
        assert!(plan.message.contains(" | onchain checks: assertions | rent cap 2039280 lamports"));
    }

    fn builder_planner(documents: &Compiled) -> (Planner<'_>, AccountMap) {
        let mut planner = Planner::new(&request(&[documents], 5_000), SCRATCH).unwrap();
        let mut accounts = chain();
        let step = fetch(&mut planner, &mut accounts, |_| Some(mint(TOKEN_2022_PROGRAM)));
        assert!(matches!(step, Step::Simulate(_)));

        (planner, accounts)
    }

    #[test]
    fn a_builder_simulation_creates_scratch_first() {
        let documents = Compiled::token_2022_transfer();
        let mut planner = Planner::new(&request(&[&documents], 5_000), SCRATCH).unwrap();
        let simulation = simulation(fetch(&mut planner, &mut chain(), |_| Some(mint(TOKEN_2022_PROGRAM))));
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
        let mut planner = Planner::new(&request(&[&documents], 5_000), SCRATCH).unwrap();

        assert_eq!(planner.simulated(SimulationResult::default()), Err(PlanError::OutOfOrder));

        let (mut planner, accounts) = builder_planner(&documents);

        assert!(planner.next(&accounts).is_err_and(|error| error == PlanError::OutOfOrder));
    }

    /// Answers each fetch with `answer` until the planner asks for something else.
    fn answer_fetches(
        planner: &mut Planner<'_>,
        accounts: &mut AccountMap,
        answer: impl Fn(&Address) -> Option<Account>,
    ) -> Step {
        loop {
            match planner.next(accounts).unwrap() {
                Step::Fetch(addresses) => accounts.insert_fetched(&addresses, addresses.iter().map(&answer).collect()),
                step => return step,
            }
        }
    }

    /// The fee payer, the sender, and the receiver after a System transfer, in the order that the
    /// simulation observes them.
    fn transfer_result(fee_payer: u64, from: u64, to: u64) -> SimulationResult {
        SimulationResult {
            accounts: vec![Some(wallet(fee_payer)), Some(wallet(from)), Some(wallet(to))],
            units_consumed: Some(300),
            ..SimulationResult::default()
        }
    }

    const QUARTER: u64 = SOL / 4;
    const TRANSFER_FEE: u64 = 10_000;

    /// Two transfers of a quarter SOL each, planned up to the simulation of the second segment.
    fn second_segment(planner: &mut Planner<'_>, accounts: &mut AccountMap) -> Simulation {
        let first = simulation(answer_fetches(planner, accounts, |_| Some(wallet(10 * SOL))));
        assert_eq!(first.transaction.instructions.len(), 1);
        assert_eq!(first.observe, [account(FEE_PAYER), account(FROM), account(TO)]);

        planner.simulated(transfer_result(10 * SOL - TRANSFER_FEE, 10 * SOL - QUARTER, 10 * SOL + QUARTER)).unwrap();
        let second = simulation(planner.next(accounts).unwrap());
        assert_eq!(second.transaction.instructions.first(), first.transaction.instructions.first());

        second
    }

    #[test]
    fn a_later_intent_runs_after_the_earlier_ones() {
        let documents = Compiled::system_transfer(SYSTEM_TRANSFER);
        let mut planner = Planner::new(&request(&[&documents, &documents], 0), SCRATCH).unwrap();
        let mut accounts = chain();

        assert_eq!(second_segment(&mut planner, &mut accounts).transaction.instructions.len(), 2);

        let after = transfer_result(10 * SOL - TRANSFER_FEE, 10 * SOL - 2 * QUARTER, 10 * SOL + 2 * QUARTER);
        planner.simulated(after).unwrap();
        let Ok(Step::Done(plan)) = planner.next(&accounts) else { panic!("the plan is done") };

        assert_eq!(plan.intents.iter().map(|intent| intent.span.clone()).collect::<Vec<_>>(), [0..1, 1..2]);
        assert_eq!(plan.transaction.instructions.len(), 2);
        assert_eq!(plan.signatures.len(), 2);
    }

    /// The second segment's checks start from the state after the first, so each segment answers
    /// only for what it moves.
    #[test]
    fn each_segment_answers_for_its_own_changes() {
        let documents = Compiled::system_transfer(SYSTEM_TRANSFER);
        let mut planner = Planner::new(&request(&[&documents, &documents], 0), SCRATCH).unwrap();
        second_segment(&mut planner, &mut chain());

        let after = transfer_result(10 * SOL - TRANSFER_FEE, 10 * SOL - 3 * QUARTER, 10 * SOL + 3 * QUARTER);

        assert!(planner.simulated(after).is_err_and(|error| matches!(error, PlanError::CheckFailed(_))));
    }

    #[test]
    fn one_message_holds_every_intent() {
        let documents = Compiled::system_transfer(SYSTEM_TRANSFER);
        let mut planner = Planner::new(&request(&[&documents, &documents], 0), SCRATCH).unwrap();
        let mut accounts = chain();
        second_segment(&mut planner, &mut accounts);

        let after = transfer_result(10 * SOL - TRANSFER_FEE, 10 * SOL - 2 * QUARTER, 10 * SOL + 2 * QUARTER);
        planner.simulated(after).unwrap();
        let Ok(Step::Done(plan)) = planner.next(&accounts) else { panic!("the plan is done") };
        let transfer = format!("transfer 0.25 SOL from {FROM} to {TO}");

        assert!(plan.message.starts_with(&format!("sdp-intents/1 || 1: {transfer} | ")));
        assert!(plan.message.contains(&format!(" || 2: {transfer} | ")));
        assert!(plan.message.ends_with(&format!(" || fee and rent payer {FEE_PAYER} | priority fee 0 lamports")));
        assert_eq!(plan.message.matches(" || ").count(), 3);
    }

    #[test]
    fn a_plan_holds_an_intent() {
        let documents = Compiled::spl_transfer();
        let request = PlanRequest { intents: Vec::new(), ..request(&[&documents], 0) };

        assert!(Planner::new(&request, SCRATCH).is_err_and(|error| error == PlanError::NoIntents));
    }
}
