//! `sdp-intents prepare`: plans a plan request over RPC against the definitions in this repository,
//! and prints the plan as JSON, in the shape of `DESIGN.md`, section 4.1.
//!
//! Until the registry exists, the documents come from the definitions tree, not from the chain.

use std::path::PathBuf;

use base64::Engine as _;
use serde_json::{json, Value};

use sdp_intents_client::{Client, ClientError, Prepared};
use sdp_intents_planner::{Instruction, IntentDocuments, PlanError, PlannedIntent};
use sdp_intents_spec::Address;

use crate::lint::{compile_tree, Outcome};
use crate::output::{self, Format};
use crate::tree::Tree;

#[derive(clap::Args)]
pub struct PrepareArgs {
    /// The plan request, as JSON: the payers, then each intent.
    request: PathBuf,

    /// The RPC that the fetches and the simulations use.
    #[arg(long)]
    rpc: String,

    /// The folder that holds `<organization>/<kind>/<name>/<version>.json`.
    #[arg(long, default_value = "definitions")]
    root: PathBuf,
}

pub fn run(args: &PrepareArgs) -> Result<Outcome, String> {
    let tree = Tree::read(&args.root)?;
    let compiled = compile_tree(&tree);

    if !compiled.reports.is_empty() {
        print!("{}", output::render(Format::Human, &compiled.reports, &[]));
        return Err("the definitions have findings, so no intent can name them".to_owned());
    }

    let text = std::fs::read_to_string(&args.request)
        .map_err(|error| format!("cannot read `{}`: {error}", args.request.display()))?;
    let request = match compiled.catalog.compile_plan(&text) {
        Ok(request) => request,
        Err(report) => {
            eprint!("{}", report.render(&args.request.display().to_string(), &text));
            return Ok(Outcome::Findings);
        }
    };

    let documents: Vec<IntentDocuments<'_>> = request
        .intents
        .iter()
        .map(|intent| IntentDocuments {
            interface: &intent.interface.bytes,
            implementation: &intent.implementation.bytes,
            intent: &intent.bytes,
        })
        .collect();
    let prepared = Client::new(&args.rpc).prepare(&documents).map_err(describe)?;
    let request_json: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let plan = serde_json::to_string_pretty(&plan_json(&prepared, request_json)).map_err(|error| error.to_string())?;

    println!("{plan}");

    Ok(Outcome::Clean)
}

/// A failed simulation also shows the program logs, which name the instruction and the reason.
fn describe(error: ClientError) -> String {
    match &error {
        ClientError::Plan(PlanError::Simulation { logs, .. }) if !logs.is_empty() => {
            format!("{error}\n\nprogram logs:\n  {}", logs.join("\n  "))
        }
        _ => error.to_string(),
    }
}

fn plan_json(prepared: &Prepared, request: Value) -> Value {
    let plan = &prepared.plan;
    let budget = plan.transaction.budget;
    let signatures: Vec<Value> = plan
        .signatures
        .iter()
        .map(|signature| json!({ "address": base58(&signature.address), "role": signature.role.as_text(), "status": "required" }))
        .collect();

    json!({
        "spec": "sdp-intents@1.0",
        "kind": "plan",
        "request": request,
        "intents": plan.intents.iter().map(intent_json).collect::<Vec<_>>(),
        "transactions": [{
            "instructions": plan.transaction.instructions.iter().map(instruction_json).collect::<Vec<_>>(),
            "version": 1,
            "config": {
                "priorityFeeLamports": plan.transaction.priority_fee_lamports.to_string(),
                "computeUnitLimit": budget.compute_unit_limit.to_string(),
                "loadedAccountsDataSizeLimit": budget.loaded_accounts_data_size_limit.to_string(),
                "heapSize": budget.heap_size.to_string(),
            },
            "compiled": base64(&prepared.message),
            "signatures": signatures,
        }],
        "simulation": { "unitsConsumed": plan.units_consumed.to_string() },
    })
}

/// `verify` and `span` are positions in the transaction's instructions.
fn intent_json(intent: &PlannedIntent) -> Value {
    json!({
        "message": intent.message,
        "display": intent.display,
        "digests": { "interface": digest(&intent.digests.interface), "implementation": digest(&intent.digests.implementation) },
        "builder": intent.builder.map(|program| json!({ "program": base58(&program) })),
        "outputs": base64(&intent.outputs),
        "verify": intent.verify,
        "span": { "start": intent.span.start, "end": intent.span.end },
        "builderSimulations": intent.builder_simulations,
    })
}

/// The `EarnVaultInstruction` shape: base58 addresses, numeric roles, and base64 data.
fn instruction_json(instruction: &Instruction) -> Value {
    let accounts: Vec<Value> = instruction
        .accounts
        .iter()
        .map(|meta| json!({ "address": base58(&meta.address), "role": u8::from(meta.role) }))
        .collect();

    json!({ "programAddress": base58(&instruction.program), "accounts": accounts, "data": base64(&instruction.data) })
}

fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

fn base64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn digest(digest: &[u8; 32]) -> String {
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();

    format!("sha256:{hex}")
}
