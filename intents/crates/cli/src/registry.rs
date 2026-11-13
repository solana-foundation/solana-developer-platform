//! `sdp-intents plan` and `sdp-intents apply`: compare the definitions with the registry, then print
//! or send the steps that make the registry hold them. The key that runs them writes each buffer.
//! It is also the authority that signs and pays every other step, unless `--squads` names a
//! multisig, whose vault is the authority. Then `apply` proposes each of those steps to the
//! multisig, and the members approve and execute them in order.

use std::collections::HashMap;
use std::path::PathBuf;

use sdp_intents_client::{read_keypair_file, Client, Keypair, Signer as _};
use sdp_intents_planner::{AccountMeta, Budget, Instruction, Transaction};
use sdp_intents_registry_client::{RegistryInstruction, REGISTRY_PROGRAM};
use sdp_intents_spec::Address;

use crate::lint::{compile_tree, Outcome};
use crate::output::{self, Format};
use crate::settings::read_settings;
use crate::squads;
use crate::sync::{Step, StepSigner, Sync};
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

    /// The keypair that writes each buffer. Without `--squads`, it is also the authority.
    #[arg(long)]
    keypair: PathBuf,

    /// A Squads v4 multisig, whose vault is the authority. The keypair must be a member who can
    /// initiate.
    #[arg(long)]
    squads: Option<String>,

    /// With `--squads`, approves and executes each proposal with the keypair. Only a member who meets
    /// the threshold alone can, as on a local multisig.
    #[arg(long, requires = "squads")]
    execute: bool,

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
    let sender = Sender { client: Client::new(&args.rpc), keypair, multisig: multisig(args)?, execute: args.execute };

    for step in &steps {
        for transaction in &step.transactions {
            let instructions: Vec<Instruction> = transaction.instructions.iter().map(instruction).collect();
            let sent = match (transaction.signer, sender.multisig) {
                (StepSigner::Authority, Some(multisig)) => sender.propose(&multisig, &instructions),
                _ => sender.send(instructions),
            };

            sent.map_err(|error| format!("{}: {error}", step.description))?;
        }

        println!("{}", step.description);
    }

    let done = match sender.multisig.is_some() && !args.execute {
        true => "Each step that needs the authority is a proposal. The members approve and execute them in order.",
        false => "The registry holds every definition.",
    };
    println!("{done}");

    Ok(Outcome::Clean)
}

/// What sends the steps of `apply`.
struct Sender {
    client: Client,
    keypair: Keypair,
    multisig: Option<Address>,
    execute: bool,
}

impl Sender {
    fn send(&self, instructions: Vec<Instruction>) -> Result<(), String> {
        let transaction = Transaction {
            fee_payer: Address(self.keypair.pubkey().to_bytes()),
            instructions,
            budget: REGISTRY_BUDGET,
            priority_fee_lamports: 0,
        };

        self.client.send(&transaction, &[&self.keypair]).map(|_| ()).map_err(|error| error.to_string())
    }

    /// Creates a vault transaction and its proposal at the multisig's next index, and with
    /// `--execute`, approves and executes it.
    fn propose(&self, multisig: &Address, instructions: &[Instruction]) -> Result<(), String> {
        let account =
            self.client.accounts(&[*multisig]).map_err(|error| error.to_string())?.into_iter().next().flatten();
        let last = squads::transaction_index(&account.ok_or("the multisig does not exist")?.data)?;
        let proposer = Address(self.keypair.pubkey().to_bytes());
        let vault_transaction = squads::VaultTransaction {
            multisig,
            index: last.checked_add(1).ok_or("the multisig has no next index")?,
            proposer: &proposer,
            instructions,
        };

        self.send(vault_transaction.create()?)?;

        if self.execute {
            self.send(vault_transaction.approve_and_execute()?)?;
        }

        Ok(())
    }
}

fn multisig(args: &SyncArgs) -> Result<Option<Address>, String> {
    args.squads
        .as_deref()
        .map(|text| parse_address(text).ok_or_else(|| format!("`{text}` is not an address")))
        .transpose()
}

fn parse_address(text: &str) -> Option<Address> {
    bs58::decode(text).into_vec().ok().and_then(|bytes| bytes.try_into().ok()).map(Address)
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

    let writer = Address(keypair.pubkey().to_bytes());
    let authority = match multisig(args)? {
        Some(multisig) => squads::vault_address(&multisig)?,
        None => writer,
    };
    let sync = Sync {
        catalog: &compiled.catalog,
        organizations: &settings.organizations,
        indexes: &settings.indexes,
        accounts: &accounts,
        writer,
        authority,
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
