//! `sdp-intents squads-create`: creates a Squads v4 multisig whose only member is the keypair, with
//! a threshold of 1, for `apply --squads --execute` on a local surfnet.

use std::path::PathBuf;

use sdp_intents_client::{read_keypair_file, Client, Keypair, Signer as _};
use sdp_intents_planner::{Budget, Transaction};
use sdp_intents_spec::Address;

use crate::lint::Outcome;
use crate::squads;

#[derive(clap::Args)]
pub struct SquadsCreateArgs {
    #[arg(long)]
    rpc: String,

    /// The keypair of the only member, which also pays.
    #[arg(long)]
    keypair: PathBuf,
}

pub fn run(args: &SquadsCreateArgs) -> Result<Outcome, String> {
    let member = read_keypair_file(&args.keypair)
        .map_err(|error| format!("cannot read the keypair `{}`: {error}", args.keypair.display()))?;
    let create_key = Keypair::new();
    let client = Client::new(&args.rpc);

    let config = client.accounts(&[squads::program_config_address()?]).map_err(|error| error.to_string())?;
    let config = config.into_iter().next().flatten().ok_or("the cluster has no Squads v4 program config")?;
    let treasury = squads::treasury(&config.data)?;

    let member_address = Address(member.pubkey().to_bytes());
    let create_address = Address(create_key.pubkey().to_bytes());
    let transaction = Transaction {
        fee_payer: member_address,
        instructions: vec![squads::create_multisig(&member_address, &create_address, &treasury)?],
        budget: Budget {
            compute_unit_limit: 200_000,
            loaded_accounts_data_size_limit: 16 * 1024 * 1024,
            heap_size: 32 * 1024,
        },
        priority_fee_lamports: 0,
    };
    client.send(&transaction, &[&member, &create_key]).map_err(|error| error.to_string())?;

    let multisig = squads::multisig_address(&create_address)?;
    println!("multisig {}", bs58::encode(multisig.0).into_string());
    println!("vault {}", bs58::encode(squads::vault_address(&multisig)?.0).into_string());

    Ok(Outcome::Clean)
}
