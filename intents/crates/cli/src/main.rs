//! The `sdp-intents` command line. `packages/sdp-intents/DESIGN.md`, section 4.13, gives the
//! commands. `lint` checks the definitions, `plan` and `apply` publish them to the registry,
//! `prepare` plans intents over RPC, and `verify` and `send` act as the plan's signer.

mod config;
mod lint;
mod multisig;
mod output;
mod prepare;
mod registry;
mod settings;
mod sign;
mod squads;
mod sync;
mod tree;

use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::lint::{LintArgs, Outcome};
use crate::multisig::SquadsCreateArgs;
use crate::prepare::PrepareArgs;
use crate::registry::SyncArgs;
use crate::sign::{SendArgs, VerifyArgs};

#[derive(Parser)]
#[command(name = "sdp-intents", version, about = "Lints and publishes SDP intent definitions, and plans intents")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Checks every definition, and exits with an error on a finding.
    Lint(LintArgs),
    /// Prints the steps that make the registry hold the definitions.
    Plan(SyncArgs),
    /// Sends the steps that make the registry hold the definitions.
    Apply(SyncArgs),
    /// Plans a plan request over RPC against the definitions, and prints the plan as JSON.
    Prepare(PrepareArgs),
    /// Renders a plan's message from its transaction and the registry, as its signer does.
    Verify(VerifyArgs),
    /// Verifies a plan, then signs and sends its transaction.
    Send(SendArgs),
    /// Creates a Squads v4 multisig of one member, for `apply --squads` on a local surfnet.
    SquadsCreate(SquadsCreateArgs),
    /// Creates the registry config, signed by the program's upgrade authority. Organizations start gated.
    InitRegistry(config::InitArgs),
    /// Lets only the admin create organizations (`on`), or anyone (`off`).
    SetOrganizationsGated(config::GateArgs),
    /// Moves the registry admin.
    SetRegistryAdmin(config::SetAdminArgs),
}

/// Exits 1 on a finding, and 2 when the command cannot run, as `clap` does for a bad argument.
fn main() -> ExitCode {
    let outcome = match Cli::parse().command {
        Command::Lint(args) => lint::run(&args),
        Command::Plan(args) => registry::plan(&args),
        Command::Apply(args) => registry::apply(&args),
        Command::Prepare(args) => prepare::run(&args),
        Command::Verify(args) => sign::verify(&args),
        Command::Send(args) => sign::send(&args),
        Command::SquadsCreate(args) => multisig::run(&args),
        Command::InitRegistry(args) => config::init(&args),
        Command::SetOrganizationsGated(args) => config::set_gate(&args),
        Command::SetRegistryAdmin(args) => config::set_admin(&args),
    };

    match outcome {
        Ok(Outcome::Clean) => ExitCode::SUCCESS,
        Ok(Outcome::Findings) => ExitCode::from(1),
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::from(2)
        }
    }
}
