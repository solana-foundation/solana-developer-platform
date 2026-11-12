//! The `sdp-intents` command line. `packages/sdp-intents/DESIGN.md`, section 4.13, gives the
//! commands. Only `lint` exists so far.

mod lint;
mod output;
mod tree;

use std::process::ExitCode;

use clap::{Parser, Subcommand};

use crate::lint::{LintArgs, Outcome};

#[derive(Parser)]
#[command(name = "sdp-intents", version, about = "Lints SDP intent definitions")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Checks every definition, and exits with an error on a finding.
    Lint(LintArgs),
}

/// Exits 1 on a finding, and 2 when the command cannot run, as `clap` does for a bad argument.
fn main() -> ExitCode {
    let outcome = match Cli::parse().command {
        Command::Lint(args) => lint::run(&args),
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
