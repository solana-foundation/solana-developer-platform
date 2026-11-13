//! `sdp-intents verify` and `sdp-intents send`: act as the signer of a plan that `prepare` printed.
//! Both render the message from the compiled transaction and the registry, never from the plan, and
//! list each instruction that no segment holds.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::Value;

use sdp_intents_client::{read_keypair_file, Client, Keypair};
use sdp_intents_planner::VerifiedTransaction;

use crate::lint::Outcome;

#[derive(clap::Args)]
pub struct VerifyArgs {
    /// The plan, as `prepare` prints it.
    plan: PathBuf,

    #[arg(long)]
    rpc: String,
}

#[derive(clap::Args)]
pub struct SendArgs {
    /// The plan, as `prepare` prints it.
    plan: PathBuf,

    #[arg(long)]
    rpc: String,

    /// A keypair of a signer that the transaction needs. Repeat it for each signer.
    #[arg(long = "keypair", required = true)]
    keypairs: Vec<PathBuf>,

    /// Sends a transaction whose message the transaction does not prove, or that holds instructions
    /// that no segment holds.
    #[arg(long)]
    allow_unverified: bool,
}

/// A plan file: the message that the service rendered, and the compiled v1 message.
struct PlanFile {
    message: String,
    compiled: Vec<u8>,
}

pub fn verify(args: &VerifyArgs) -> Result<Outcome, String> {
    let plan = read_plan(&args.plan)?;
    let verified = Client::new(&args.rpc).verify_message(&plan.compiled).map_err(|error| error.to_string())?;

    Ok(report(&plan, &verified))
}

pub fn send(args: &SendArgs) -> Result<Outcome, String> {
    let plan = read_plan(&args.plan)?;
    let client = Client::new(&args.rpc);
    let verified = client.verify_message(&plan.compiled).map_err(|error| error.to_string())?;

    if report(&plan, &verified) == Outcome::Findings && !args.allow_unverified {
        return Err("the transaction does not prove the plan. Pass --allow-unverified to send it anyway.".into());
    }

    let keypairs = args
        .keypairs
        .iter()
        .map(|path| read_keypair_file(path).map_err(|error| format!("cannot read `{}`: {error}", path.display())))
        .collect::<Result<Vec<Keypair>, _>>()?;
    let signers: Vec<&Keypair> = keypairs.iter().collect();
    let signature = client.send_message(&plan.compiled, &signers).map_err(|error| error.to_string())?;

    println!("sent {signature}");

    Ok(Outcome::Clean)
}

/// Prints what the transaction proves. A message that differs from the plan's, or an instruction
/// that no segment holds, is a finding.
fn report(plan: &PlanFile, verified: &VerifiedTransaction) -> Outcome {
    let matches = verified.message == plan.message;

    println!("{}", verified.message);
    println!("{}", if matches { "The message matches the plan." } else { "The message differs from the plan." });
    verified.unverified.iter().for_each(|position| println!("instruction {position} is in no segment"));

    match matches && verified.unverified.is_empty() {
        true => Outcome::Clean,
        false => Outcome::Findings,
    }
}

fn read_plan(path: &Path) -> Result<PlanFile, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let message = value.get("message").and_then(Value::as_str).ok_or("the plan has no message")?;
    let compiled = value
        .pointer("/transactions/0/compiled")
        .and_then(Value::as_str)
        .ok_or("the plan has no compiled transaction")?;
    let compiled = base64::engine::general_purpose::STANDARD.decode(compiled).map_err(|error| error.to_string())?;

    Ok(PlanFile { message: message.to_owned(), compiled })
}
