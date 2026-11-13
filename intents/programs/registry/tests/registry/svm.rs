//! LiteSVM with the registry and the test builder, and a transaction sender whose failure names
//! the custom error code.

use anchor_lang::solana_program::instruction::Instruction;
use anchor_v2_testing::litesvm::types::TransactionMetadata;
use anchor_v2_testing::litesvm::LiteSVM;
use anchor_v2_testing::{Keypair, Message, Signer, VersionedMessage, VersionedTransaction};
use registry::RegistryError;
use sdp_intents_planner::Plan;
use sdp_intents_program_testing::SendError;

const REGISTRY: &[u8] = include_bytes!("../../../target/deploy/registry.so");
const TEST_BUILDER: &[u8] = include_bytes!("../../../target/deploy/test_builder.so");
pub const SOL: u64 = 1_000_000_000;

/// The code that Anchor gives a custom error.
const ERROR_CODE_OFFSET: u32 = 6_000;

#[derive(Debug)]
pub struct Failure {
    pub error: String,
    pub logs: Vec<String>,
}

/// The error, then the program logs, one line each.
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "{}", self.error)?;

        self.logs.iter().try_for_each(|line| writeln!(f, "  {line}"))
    }
}

impl Failure {
    pub fn custom_code(&self) -> Option<u32> {
        let (_, rest) = self.error.split_once("Custom(")?;
        let (code, _) = rest.split_once(')')?;

        code.parse().ok()
    }

    pub fn is(&self, error: RegistryError) -> bool {
        self.custom_code() == Some(ERROR_CODE_OFFSET.saturating_add(error as u32))
    }
}

pub fn svm() -> Result<LiteSVM, Failure> {
    let mut svm = sdp_intents_program_testing::svm().map_err(failure)?;
    svm.add_program(registry::ID, REGISTRY).map_err(|error| failure(format!("{error:?}")))?;
    svm.add_program(test_builder::ID, TEST_BUILDER).map_err(|error| failure(format!("{error:?}")))?;

    Ok(svm)
}

/// A new keypair that holds `lamports`.
pub fn funded(svm: &mut LiteSVM, lamports: u64) -> Result<Keypair, Failure> {
    let keypair = Keypair::new();
    svm.airdrop(&keypair.pubkey(), lamports).map_err(|failed| failure(format!("{:?}", failed.err)))?;

    Ok(keypair)
}

/// Sends `instructions` in one transaction. The first signer pays the fee.
pub fn send(
    svm: &mut LiteSVM,
    instructions: &[Instruction],
    signers: &[&Keypair],
) -> Result<TransactionMetadata, Failure> {
    let fee_payer = signers.first().ok_or_else(|| failure("a transaction needs a fee payer".into()))?.pubkey();
    let message = Message::new_with_blockhash(instructions, Some(&fee_payer), &svm.latest_blockhash());
    let transaction = VersionedTransaction::try_new(VersionedMessage::Legacy(message), signers)
        .map_err(|error| failure(error.to_string()))?;
    let sent = svm.send_transaction(transaction);
    svm.expire_blockhash();

    sent.map_err(|failed| Failure { error: format!("{:?}", failed.err), logs: failed.meta.logs })
}

pub fn failure(error: String) -> Failure {
    Failure { error, logs: Vec::new() }
}

/// The compute units that the program at `program` used in a top-level instruction, from the log
/// line that the runtime writes when it returns.
pub fn units_consumed(logs: &[String], program: &anchor_lang::Address) -> Option<u64> {
    let prefix = format!("Program {program} consumed ");

    logs.iter().find_map(|line| line.strip_prefix(&prefix)?.split_once(' ')?.0.parse().ok())
}

/// Sends the plan's transaction with the harness, which puts the ComputeBudget instructions first.
pub fn send_plan(svm: &mut LiteSVM, plan: &Plan, signers: &[&Keypair]) -> Result<TransactionMetadata, Failure> {
    let sent = sdp_intents_program_testing::send(svm, plan, signers);
    svm.expire_blockhash();

    sent.map_err(|error| match error {
        SendError::Failed(failed) => Failure { error: format!("{:?}", failed.err), logs: failed.meta.logs },
        SendError::Sign(error) => failure(error),
    })
}
