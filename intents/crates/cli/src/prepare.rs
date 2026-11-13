//! `sdp-intents prepare`: plans a plan request over RPC against the definitions in this repository,
//! and prints the plan as JSON, in the shape of `DESIGN.md`, section 4.1.
//!
//! The documents come from the definitions tree. The service reads them from the registry, and
//! `just e2e` checks that both plan the same message.

use std::path::PathBuf;

use serde_json::Value;

use sdp_intents_client::{json, Client, ClientError};
use sdp_intents_planner::{IntentDocuments, Payers, PlanError, PlanRequest};

use sdp_intents_compiler::{CompiledPlan, PlanOutput};

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

    let plan_request = plan_request(&request);
    let client = Client::new(&args.rpc);
    let prepared = match request.output {
        PlanOutput::Transaction => client.prepare(&plan_request),
        PlanOutput::Instructions => client.prepare_instructions(&plan_request),
    }
    .map_err(describe)?;
    let request_json: Value = serde_json::from_str(&text).map_err(|error| error.to_string())?;
    let plan = serde_json::to_string_pretty(&json::plan(&prepared, request_json)).map_err(|error| error.to_string())?;

    println!("{plan}");

    Ok(Outcome::Clean)
}

/// The planner's request for a compiled plan request.
pub fn plan_request<'a>(request: &'a CompiledPlan<'_>) -> PlanRequest<'a> {
    PlanRequest {
        intents: request
            .intents
            .iter()
            .map(|intent| IntentDocuments {
                interface: &intent.interface.bytes,
                implementation: &intent.implementation.bytes,
                intent: &intent.bytes,
            })
            .collect(),
        payers: Payers { fee: &request.payers.fee, rent: &request.payers.rent },
        priority_fee_lamports: request.priority_fee_lamports,
    }
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
