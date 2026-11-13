//! `sdp-intents plan` and `sdp-intents apply`: compare the definitions with the registry, then print
//! or send the steps that make the registry hold them. The signer creates each organization as its
//! authority, and pays for every account.

use std::collections::HashMap;
use std::path::PathBuf;

use sdp_intents_client::{read_keypair_file, Client, Keypair, Signer as _};
use sdp_intents_planner::{AccountMeta, Budget, Instruction, Transaction};
use sdp_intents_registry_client::{RegistryInstruction, REGISTRY_PROGRAM};
use sdp_intents_spec::Address;

use crate::lint::{compile_tree, Outcome};
use crate::output::{self, Format};
use crate::settings::read_settings;
use crate::sync::{Step, Sync};
use crate::tree::Tree;

/// The budget of each registry transaction. The largest, `publish`, hashes a document of at most
/// 10,000 bytes.
const REGISTRY_BUDGET: Budget =
    Budget { compute_unit_limit: 400_000, loaded_accounts_data_size_limit: 16 * 1024 * 1024, heap_size: 32 * 1024 };

#[derive(clap::Args)]
pub struct SyncArgs {
    /// The cluster that holds the registry.
    #[arg(long)]
    rpc: String,

    /// The keypair that signs, pays, and is each new organization's authority.
    #[arg(long)]
    keypair: PathBuf,

    /// The folder that holds `<organization>/<kind>/<name>/<version>.json`.
    #[arg(long, default_value = "definitions")]
    root: PathBuf,
}

pub fn plan(args: &SyncArgs) -> Result<Outcome, String> {
    let steps = planned(args)?.steps;

    if steps.is_empty() {
        println!("The registry holds every definition.");
    }

    for step in &steps {
        let count = step.transactions.len();
        println!("{} ({count} transaction{})", step.description, if count == 1 { "" } else { "s" });
    }

    Ok(Outcome::Clean)
}

pub fn apply(args: &SyncArgs) -> Result<Outcome, String> {
    let Planned { keypair, steps } = planned(args)?;
    let client = Client::new(&args.rpc);

    for step in &steps {
        for instructions in &step.transactions {
            let transaction = Transaction {
                fee_payer: Address(keypair.pubkey().to_bytes()),
                instructions: instructions.iter().map(instruction).collect(),
                budget: REGISTRY_BUDGET,
                priority_fee_lamports: 0,
            };
            client.send(&transaction, &[&keypair]).map_err(|error| format!("{}: {error}", step.description))?;
        }

        println!("{}", step.description);
    }

    println!("The registry holds every definition.");

    Ok(Outcome::Clean)
}

/// The signer, and the steps that the registry still needs.
struct Planned {
    keypair: Keypair,
    steps: Vec<Step>,
}

fn planned(args: &SyncArgs) -> Result<Planned, String> {
    let keypair = read_keypair_file(&args.keypair)
        .map_err(|error| format!("cannot read the keypair `{}`: {error}", args.keypair.display()))?;
    let tree = Tree::read(&args.root)?;
    let compiled = compile_tree(&tree);

    if !compiled.reports.is_empty() {
        print!("{}", output::render(Format::Human, &compiled.reports, &[]));
        return Err("the definitions have findings, so they cannot be published".to_owned());
    }

    let settings = read_settings(&tree)?;
    let addresses = Sync::addresses(&compiled.catalog)?;
    let fetched = Client::new(&args.rpc).accounts(&addresses).map_err(|error| error.to_string())?;
    let accounts: HashMap<_, _> = addresses
        .into_iter()
        .zip(fetched)
        .filter_map(|(address, account)| account.map(|account| (address, account)))
        .collect();

    let sync = Sync {
        catalog: &compiled.catalog,
        organizations: &settings.organizations,
        indexes: &settings.indexes,
        accounts: &accounts,
        signer: Address(keypair.pubkey().to_bytes()),
    };
    let steps = sync.steps()?;

    Ok(Planned { keypair, steps })
}

fn instruction(instruction: &RegistryInstruction) -> Instruction {
    Instruction {
        program: REGISTRY_PROGRAM,
        accounts: instruction
            .accounts
            .iter()
            .map(|meta| AccountMeta { address: meta.address, role: meta.role })
            .collect(),
        data: instruction.data.clone(),
    }
}
