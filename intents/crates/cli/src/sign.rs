//! `sdp-intents verify` and `sdp-intents send`: act as the signer of a plan that `prepare` printed.
//! Both render the message from the compiled transaction and the registry, never from the plan, and
//! list each instruction that no segment holds.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::Value;

use sdp_intents_client::remote::frozen_from_parts;
use sdp_intents_client::{read_keypair_file, Client, Keypair};
use sdp_intents_planner::{ProviderSignature, VerifiedTransaction};
use sdp_intents_spec::Address;

use crate::lint::{compile_tree, Outcome};
use crate::prepare::plan_request;
use crate::tree::Tree;

#[derive(clap::Args)]
pub struct VerifyArgs {
    /// The plan, as `prepare` prints it.
    plan: PathBuf,

    #[arg(long)]
    rpc: String,

    /// The definitions that a provider's transaction is planned again against.
    #[arg(long, default_value = "definitions")]
    root: PathBuf,
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

    #[arg(long, default_value = "definitions")]
    root: PathBuf,
}

/// A plan file: the message that the service rendered, the compiled v1 message, and, for a
/// provider's transaction, its signatures and the request that it answers.
struct PlanFile {
    message: String,
    compiled: Vec<u8>,
    presigned: Vec<ProviderSignature>,
    request: Option<Value>,
}

pub fn verify(args: &VerifyArgs) -> Result<Outcome, String> {
    let plan = read_plan(&args.plan)?;

    verified(&plan, &Client::new(&args.rpc), &args.root)
}

pub fn send(args: &SendArgs) -> Result<Outcome, String> {
    let plan = read_plan(&args.plan)?;
    let client = Client::new(&args.rpc);

    if verified(&plan, &client, &args.root)? == Outcome::Findings && !args.allow_unverified {
        return Err("the transaction does not prove the plan. Pass --allow-unverified to send it anyway.".into());
    }

    let keypairs = args
        .keypairs
        .iter()
        .map(|path| read_keypair_file(path).map_err(|error| format!("cannot read `{}`: {error}", path.display())))
        .collect::<Result<Vec<Keypair>, _>>()?;
    let signers: Vec<&Keypair> = keypairs.iter().collect();
    let signature =
        client.send_presigned(&plan.compiled, &signers, &plan.presigned).map_err(|error| error.to_string())?;

    println!("sent {signature}");

    Ok(Outcome::Clean)
}

/// A provider's transaction holds no `verify_intent`, so the signer plans the request again with the
/// transaction as the endpoint's answer, which checks every postcondition in a new simulation.
/// Any other transaction proves its message through its `verify_intent`.
fn verified(plan: &PlanFile, client: &Client, root: &Path) -> Result<Outcome, String> {
    if plan.presigned.is_empty() {
        let verified = client.verify_message(&plan.compiled).map_err(|error| error.to_string())?;

        return Ok(report(plan, &verified));
    }

    let request = plan.request.as_ref().ok_or("the plan of a provider's transaction has no request")?;
    let text = serde_json::to_string(request).map_err(|error| error.to_string())?;
    let tree = Tree::read(root)?;
    let compiled = compile_tree(&tree);
    let compiled_request = compiled.catalog.compile_plan(&text).map_err(|report| report.render("request", &text))?;
    let frozen = frozen_from_parts(&plan.compiled, plan.presigned.clone()).map_err(|error| error.to_string())?;
    let replanned = client.replan(&plan_request(&compiled_request), frozen).map_err(|error| error.to_string())?;
    let matches = replanned.message == plan.message;

    println!("{}", replanned.message);
    println!("A new simulation of the provider's transaction checks every guarantee. Nothing onchain checks them.");
    println!("{}", if matches { "The message matches the plan." } else { "The message differs from the plan." });

    Ok(if matches { Outcome::Clean } else { Outcome::Findings })
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
        .pointer("/transaction/compiled")
        .and_then(Value::as_str)
        .ok_or("the plan has no compiled transaction")?;
    let compiled = base64::engine::general_purpose::STANDARD.decode(compiled).map_err(|error| error.to_string())?;
    let presigned = value
        .pointer("/transaction/presigned")
        .and_then(Value::as_array)
        .map(|listed| listed.iter().map(provider_signature).collect::<Result<Vec<_>, _>>())
        .transpose()?
        .unwrap_or_default();

    Ok(PlanFile { message: message.to_owned(), compiled, presigned, request: value.get("request").cloned() })
}

fn provider_signature(entry: &Value) -> Result<ProviderSignature, String> {
    let decode = |key: &str| entry.get(key).and_then(Value::as_str).and_then(|text| bs58::decode(text).into_vec().ok());
    let signer = decode("address").and_then(|bytes| <[u8; 32]>::try_from(bytes).ok());
    let signature = decode("signature").and_then(|bytes| <[u8; 64]>::try_from(bytes).ok());

    match (signer, signature) {
        (Some(signer), Some(signature)) => Ok(ProviderSignature { signer: Address(signer), signature }),
        _ => Err("each `presigned` entry has a base58 address and signature".into()),
    }
}
