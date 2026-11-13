//! Prepares intents against LiteSVM with the planner, as `sdp-intents-client` does against RPC, so a
//! program's tests run the same `prepare` that the service runs.
//!
//! ```no_run
//! use sdp_intents_program_testing::{definitions, prepare, send, svm, Documents};
//!
//! # fn run(intent: &str, fee_payer: &solana_address::Address, signers: &[&anchor_v2_testing::Keypair]) -> Result<(), Box<dyn std::error::Error>> {
//! let mut svm = svm();
//! let documents =
//!     Documents::compile(&[definitions::TOKEN_TRANSFER], &[definitions::SYSTEM_TRANSFER], intent, fee_payer)?;
//! let plan = prepare(&svm, &documents)?;
//! send(&mut svm, &plan, signers).map_err(|error| format!("{error:?}"))?;
//! # Ok(())
//! # }
//! ```
//!
//! LiteSVM 0.18 has no v1 transactions, so a simulation runs as a legacy transaction with the
//! ComputeBudget instructions of its budget first. The planner checks only the plan's instructions,
//! so those instructions do not change a check.

mod convert;

use anchor_v2_testing::litesvm::types::{FailedTransactionMetadata, TransactionMetadata};
use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Message, VersionedMessage, VersionedTransaction};
use solana_signature::Signature;

use sdp_intents_compiler::Catalog;
use sdp_intents_planner::{
    Account, AccountMap, IntentDocuments, Payers, Plan, PlanError, PlanRequest, Planner, ReturnData, Simulation,
    SimulationResult, Step,
};
use sdp_intents_spec::Address;

use crate::convert::{instructions, solana_address};

/// The definitions of this repository, for a test catalog.
pub mod definitions {
    pub const TOKEN_TRANSFER: &str =
        include_str!("../../../definitions/solana.org/interfaces/token.transfer/1.0.0.json");
    pub const SYSTEM_TRANSFER: &str =
        include_str!("../../../definitions/solana.org/implementations/system-transfer/1.0.0.json");
    pub const SPL_TOKEN_TRANSFER: &str =
        include_str!("../../../definitions/solana.org/implementations/spl-token-transfer/1.0.0.json");
    pub const TOKEN_2022_TRANSFER: &str =
        include_str!("../../../definitions/solana.org/implementations/token-2022-transfer/1.0.0.json");
}

/// A mainnet program that a test runs, from `<crate_dir>/fixtures/<file>`. The binaries stay out of
/// git: `node fetch-programs.mjs` in `intents/programs` fetches them and checks their pinned hashes.
pub fn fixture_program(crate_dir: &str, file: &str) -> Result<Vec<u8>, String> {
    let path = std::path::Path::new(crate_dir).join("fixtures").join(file);

    std::fs::read(&path).map_err(|error| {
        format!("cannot read {}: {error}. Run `node fetch-programs.mjs` in intents/programs.", path.display())
    })
}

/// A scratch address for the planner. LiteSVM holds no account there.
const SCRATCH: Address = Address([0x5c; 32]);

/// A LiteSVM that checks no signatures, as a simulation over RPC with `sigVerify` off.
pub fn svm() -> LiteSVM {
    LiteSVM::new().with_sigverify(false)
}

/// The three documents of one intent, compiled, and the account that pays for its plan.
pub struct Documents {
    pub interface: Vec<u8>,
    pub implementation: Vec<u8>,
    pub intent: Vec<u8>,
    pub fee_payer: Address,
}

impl Documents {
    /// Compiles the interfaces, then the implementations, then the intent, as `sdp-intents prepare`
    /// does. The error is the rendered findings.
    pub fn compile(
        interfaces: &[&str],
        implementations: &[&str],
        intent: &str,
        fee_payer: &solana_address::Address,
    ) -> Result<Self, String> {
        let mut catalog = Catalog::default().with_publisher("solana.org", Address([7; 32]));

        for text in interfaces {
            catalog.compile_interface(text).map_err(|report| report.render("interface.json", text))?;
        }

        for text in implementations {
            catalog.compile_implementation(text).map_err(|report| report.render("implementation.json", text))?;
        }

        let compiled = catalog.compile_intent(intent).map_err(|report| report.render("intent.json", intent))?;

        Ok(Self {
            interface: compiled.interface.bytes.clone(),
            implementation: compiled.implementation.bytes.clone(),
            intent: compiled.bytes,
            fee_payer: Address(fee_payer.to_bytes()),
        })
    }

    /// A plan of this intent alone. The fee payer pays the fee and the rent, with no priority fee.
    pub fn request(&self) -> PlanRequest<'_> {
        PlanRequest {
            intents: vec![self.as_intent()],
            payers: Payers { fee: &self.fee_payer, rent: &self.fee_payer },
            priority_fee_lamports: 0,
        }
    }

    pub fn as_intent(&self) -> IntentDocuments<'_> {
        IntentDocuments { interface: &self.interface, implementation: &self.implementation, intent: &self.intent }
    }
}

/// Runs the planner for one intent, answering each fetch and each simulation from `svm`.
pub fn prepare(svm: &LiteSVM, documents: &Documents) -> Result<Plan, PlanError> {
    prepare_intents(svm, &[documents])
}

/// [`prepare`] for a plan of one or more intents, in order. The first intent's fee payer pays the
/// fee and the rent, with no priority fee.
pub fn prepare_intents(svm: &LiteSVM, intents: &[&Documents]) -> Result<Plan, PlanError> {
    let first = intents.first().ok_or(PlanError::NoIntents)?;
    let request =
        PlanRequest { intents: intents.iter().map(|documents| documents.as_intent()).collect(), ..first.request() };
    let mut planner = Planner::new(&request, SCRATCH)?;
    let mut accounts = AccountMap::default();

    loop {
        match planner.next(&accounts)? {
            Step::Fetch(addresses) => {
                let fetched = addresses.iter().map(|address| fetch(svm, address)).collect();
                accounts.insert_fetched(&addresses, fetched);
            }
            Step::Simulate(simulation) => planner.simulated(simulate(svm, &simulation))?,
            Step::Done(plan) => return Ok(*plan),
        }
    }
}

pub fn fetch(svm: &LiteSVM, address: &Address) -> Option<Account> {
    svm.get_account(&solana_address(address)).map(|account| Account {
        owner: Address(account.owner.to_bytes()),
        lamports: account.lamports,
        data: account.data,
    })
}

/// Simulates as an RPC does with `sigVerify` off, and returns the observed accounts after the run.
pub fn simulate(svm: &LiteSVM, simulation: &Simulation) -> SimulationResult {
    let transaction = unsigned(svm, &simulation.transaction);

    match svm.simulate_transaction(transaction) {
        Ok(info) => {
            let after = |address: &Address| {
                let post = info.post_accounts.iter().find(|(key, _)| key.to_bytes() == address.0);

                match post {
                    Some((_, account)) => convert::post_account(account),
                    None => fetch(svm, address),
                }
            };

            SimulationResult { accounts: simulation.observe.iter().map(after).collect(), ..result(&info.meta) }
        }
        Err(failed) => SimulationResult { error: Some(format!("{:?}", failed.err)), ..result(&failed.meta) },
    }
}

fn result(meta: &TransactionMetadata) -> SimulationResult {
    let return_data = (!meta.return_data.data.is_empty()).then(|| ReturnData {
        program: Address(meta.return_data.program_id.to_bytes()),
        data: meta.return_data.data.clone(),
    });

    SimulationResult {
        error: None,
        logs: meta.logs.clone(),
        return_data,
        accounts: Vec::new(),
        units_consumed: Some(meta.compute_units_consumed),
        loaded_accounts_data_size: Some(meta.loaded_accounts_data_size),
        fee: Some(meta.fee),
    }
}

#[derive(Debug)]
pub enum SendError {
    /// A signer is missing, or signs for no account of the transaction.
    Sign(String),
    Failed(Box<FailedTransactionMetadata>),
}

/// Sends the plan's transaction, signed by `signers`.
pub fn send(svm: &mut LiteSVM, plan: &Plan, signers: &[&Keypair]) -> Result<TransactionMetadata, SendError> {
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(
        &instructions(&plan.transaction),
        Some(&solana_address(&plan.transaction.fee_payer)),
        &blockhash,
    );
    let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers)
        .map_err(|error| SendError::Sign(error.to_string()))?;

    svm.send_transaction(transaction).map_err(|failed| SendError::Failed(Box::new(failed)))
}

fn unsigned(svm: &LiteSVM, transaction: &sdp_intents_planner::Transaction) -> VersionedTransaction {
    let blockhash = svm.latest_blockhash();
    let message = Message::new_with_blockhash(
        &instructions(transaction),
        Some(&solana_address(&transaction.fee_payer)),
        &blockhash,
    );
    let signatures = vec![Signature::default(); usize::from(message.header.num_required_signatures)];

    VersionedTransaction { signatures, message: VersionedMessage::Legacy(message) }
}
