//! `sdp-intents init-registry`, `set-organizations-gated`, and `set-registry-admin`: the registry's
//! own config. Its upgrade authority creates it once, with organizations gated to the admin. The
//! admin then changes it, directly or through a Squads proposal when `--squads` names the admin's
//! multisig.

use std::path::PathBuf;

use sdp_intents_client::{read_keypair_file, Client, Keypair, Signer as _};
use sdp_intents_registry_client::{self as registry, RegistryInstruction};
use sdp_intents_spec::Address;

use crate::lint::Outcome;
use crate::registry::{instruction, parse_address, Sender};
use crate::squads;

#[derive(clap::Args)]
pub struct InitArgs {
    #[arg(long)]
    rpc: String,

    /// The registry program's upgrade authority. It signs and pays.
    #[arg(long)]
    keypair: PathBuf,

    /// The key or vault that admits organizations.
    #[arg(long)]
    admin: String,
}

#[derive(clap::Args)]
pub struct AdminArgs {
    #[arg(long)]
    rpc: String,

    /// The admin, or with `--squads` a member of the admin's multisig who can initiate.
    #[arg(long)]
    keypair: PathBuf,

    /// A Squads v4 multisig, whose vault is the admin.
    #[arg(long)]
    squads: Option<String>,

    /// With `--squads`, approves and executes the proposal with the keypair.
    #[arg(long, requires = "squads")]
    execute: bool,
}

#[derive(clap::Args)]
pub struct GateArgs {
    #[command(flatten)]
    admin: AdminArgs,

    /// `on` lets only the admin create organizations. `off` lets anyone.
    #[arg(value_parser = ["on", "off"])]
    gate: String,
}

#[derive(clap::Args)]
pub struct SetAdminArgs {
    #[command(flatten)]
    admin: AdminArgs,

    /// The new admin.
    new_admin: String,
}

/// Creates the config once. When it exists, prints its admin and changes nothing, so a setup script
/// can run again.
pub fn init(args: &InitArgs) -> Result<Outcome, String> {
    let client = Client::new(&args.rpc);
    let config_address = registry::config_address().map_err(|error| error.to_string())?;
    let existing = client.accounts(&[config_address]).map_err(|error| error.to_string())?.into_iter().next().flatten();

    if let Some(account) = existing {
        let config = registry::ConfigView::parse(&account.data).map_err(|error| error.to_string())?;
        let gate = if config.organizations_gated() { "gates" } else { "does not gate" };
        println!("The registry config exists. Its admin is {}, and it {gate} organizations.", base58(config.admin()));

        return Ok(Outcome::Clean);
    }

    let keypair = keypair(&args.keypair)?;
    let signer = Address(keypair.pubkey().to_bytes());
    let created =
        registry::initialize_config(&signer, &signer, &address(&args.admin)?).map_err(|error| error.to_string())?;

    let sender = Sender { client, keypair, multisig: None, execute: false };
    sender.send(vec![instruction(&created)])?;
    println!("The registry config admits organizations only through {}.", args.admin);

    Ok(Outcome::Clean)
}

pub fn set_gate(args: &GateArgs) -> Result<Outcome, String> {
    let gated = args.gate == "on";
    let admin = AdminSender::new(&args.admin)?;
    let built = registry::set_organizations_gated(&admin.admin, gated).map_err(|error| error.to_string())?;

    admin.submit(&built, if gated { "Only the admin creates organizations." } else { "Anyone creates organizations." })
}

pub fn set_admin(args: &SetAdminArgs) -> Result<Outcome, String> {
    let admin = AdminSender::new(&args.admin)?;
    let built =
        registry::set_registry_admin(&admin.admin, &address(&args.new_admin)?).map_err(|error| error.to_string())?;

    admin.submit(&built, &format!("The registry admin is {}.", args.new_admin))
}

/// The admin, which is the keypair or the vault of `--squads`, and what sends as it.
struct AdminSender {
    admin: Address,
    sender: Sender,
}

impl AdminSender {
    fn new(args: &AdminArgs) -> Result<Self, String> {
        let keypair = keypair(&args.keypair)?;
        let multisig = args.squads.as_deref().map(address).transpose()?;
        let admin = match multisig {
            Some(multisig) => squads::vault_address(&multisig)?,
            None => Address(keypair.pubkey().to_bytes()),
        };

        Ok(Self { admin, sender: Sender { client: Client::new(&args.rpc), keypair, multisig, execute: args.execute } })
    }

    fn submit(&self, built: &RegistryInstruction, done: &str) -> Result<Outcome, String> {
        match self.sender.multisig {
            Some(multisig) => self.sender.propose(&multisig, &[instruction(built)])?,
            None => self.sender.send(vec![instruction(built)])?,
        }

        let proposed = self.sender.multisig.is_some() && !self.sender.execute;
        println!("{}", if proposed { "The change is a proposal to the multisig." } else { done });

        Ok(Outcome::Clean)
    }
}

fn keypair(path: &PathBuf) -> Result<Keypair, String> {
    read_keypair_file(path).map_err(|error| format!("cannot read the keypair `{}`: {error}", path.display()))
}

fn base58(address: &Address) -> String {
    bs58::encode(address.0).into_string()
}

fn address(text: &str) -> Result<Address, String> {
    parse_address(text).ok_or_else(|| format!("`{text}` is not an address"))
}
