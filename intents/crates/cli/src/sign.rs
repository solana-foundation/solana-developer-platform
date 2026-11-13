//! `sdp-intents verify` and `sdp-intents send`: act as the signer of a plan that `prepare` printed.
//! Both render the message from the compiled transaction and the registry, never from the plan, and
//! list each instruction that no segment holds. A plan of instructions alone compiles to a
//! transaction of `--version`, with a recent blockhash.

use std::path::{Path, PathBuf};

use base64::Engine as _;
use serde_json::Value;

use sdp_intents_client::{read_keypair_file, remote, Client, Keypair, MessageVersion};
use sdp_intents_planner::{Budget, ProviderSignature, Transaction, VerifiedTransaction};
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

    #[command(flatten)]
    compile: CompileArgs,
}

/// How a plan of instructions alone compiles to a transaction.
#[derive(clap::Args)]
pub struct CompileArgs {
    /// The version of the transaction: `legacy`, `0`, or `1`.
    #[arg(long, default_value = "1", value_parser = parse_version)]
    version: MessageVersion,

    /// A lookup table of a v0 transaction. Repeat it for each table.
    #[arg(long = "lookup-table", value_parser = parse_address)]
    lookup_tables: Vec<Address>,
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

    #[command(flatten)]
    compile: CompileArgs,
}

/// A plan file: the message that the service rendered, the compiled message, and, for a provider's
/// transaction, its signatures and the request that it answers.
struct PlanFile {
    message: String,
    compiled: Vec<u8>,
    presigned: Vec<ProviderSignature>,
    request: Option<Value>,
}

pub fn verify(args: &VerifyArgs) -> Result<Outcome, String> {
    let client = Client::new(&args.rpc);
    let plan = read_plan(&args.plan, &client, &args.compile)?;

    verified(&plan, &client, &args.root)
}

pub fn send(args: &SendArgs) -> Result<Outcome, String> {
    let client = Client::new(&args.rpc);
    let plan = read_plan(&args.plan, &client, &args.compile)?;

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
    let frozen = client.frozen(&plan.compiled, plan.presigned.clone()).map_err(|error| error.to_string())?;
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

/// The plan at `path`. A plan of instructions alone compiles here, as `compile` says, and the
/// command prints the message so that another verifier can read the same bytes.
fn read_plan(path: &Path, client: &Client, compile: &CompileArgs) -> Result<PlanFile, String> {
    let text = std::fs::read_to_string(path).map_err(|error| format!("cannot read `{}`: {error}", path.display()))?;
    let value: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let message = value.get("message").and_then(Value::as_str).ok_or("the plan has no message")?;
    let request = value.get("request").cloned();

    let Some(compiled) = value.pointer("/transaction/messageBytes").and_then(Value::as_str) else {
        let transaction = planned_transaction(&value)?;
        let compiled =
            client.compile(&transaction, compile.version, &compile.lookup_tables).map_err(|error| error.to_string())?;
        println!("messageBytes {}", base64::engine::general_purpose::STANDARD.encode(compiled.bytes()));

        return Ok(PlanFile {
            message: message.to_owned(),
            compiled: compiled.bytes().to_vec(),
            presigned: Vec::new(),
            request,
        });
    };

    if compile.version != MessageVersion::V1 || !compile.lookup_tables.is_empty() {
        return Err("the plan holds its transaction, so `--version` and `--lookup-table` do not apply".into());
    }

    let compiled = base64::engine::general_purpose::STANDARD.decode(compiled).map_err(|error| error.to_string())?;
    let presigned = value
        .pointer("/transaction/presigned")
        .and_then(Value::as_array)
        .map(|listed| listed.iter().map(provider_signature).collect::<Result<Vec<_>, _>>())
        .transpose()?
        .unwrap_or_default();

    Ok(PlanFile { message: message.to_owned(), compiled, presigned, request })
}

/// The transaction of a plan of instructions alone: the request's fee payer, the plan's
/// instructions, its compute budget, and its priority fee.
fn planned_transaction(plan: &Value) -> Result<Transaction, String> {
    let text =
        |pointer: &str| plan.pointer(pointer).and_then(Value::as_str).ok_or(format!("the plan has no `{pointer}`"));
    let number = |pointer: &str| text(pointer)?.parse::<u64>().map_err(|_| format!("`{pointer}` is not an integer"));
    let limit = |pointer: &str| u32::try_from(number(pointer)?).map_err(|_| format!("`{pointer}` is too large"));
    let instructions = plan
        .get("instructions")
        .and_then(Value::as_array)
        .ok_or("the plan has no transaction and no instructions")?
        .iter()
        .map(remote::instruction)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;

    Ok(Transaction {
        fee_payer: parse_address(text("/request/payers/fee")?)?,
        instructions,
        budget: Budget {
            compute_unit_limit: limit("/computeBudget/unitLimit")?,
            loaded_accounts_data_size_limit: limit("/computeBudget/loadedAccountsDataSizeLimit")?,
            heap_size: limit("/computeBudget/heapSize")?,
        },
        priority_fee_lamports: number("/priorityFeeLamports")?,
    })
}

fn parse_version(text: &str) -> Result<MessageVersion, String> {
    MessageVersion::parse(text).ok_or_else(|| "the version is `legacy`, `0`, or `1`".to_owned())
}

fn parse_address(text: &str) -> Result<Address, String> {
    let bytes = bs58::decode(text).into_vec().map_err(|_| format!("`{text}` is not base58"))?;

    <[u8; 32]>::try_from(bytes).map(Address).map_err(|_| format!("`{text}` is not an address"))
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
