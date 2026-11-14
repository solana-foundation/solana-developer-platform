//! `sdp-intents-local-wallet --wallets <folder>`: the playground's wallet on `--listen`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;

use clap::Parser;

use sdp_intents_client::Client;
use sdp_intents_local_wallet::{router, Keys, Wallet};
use sdp_intents_privacy_rings::Endpoints;

#[derive(Parser)]
#[command(name = "sdp-intents-local-wallet", about = "Local keypairs for the intents playground")]
struct Args {
    #[arg(long, default_value = "http://127.0.0.1:8899")]
    rpc: String,

    #[arg(long, default_value = "127.0.0.1:8794")]
    listen: SocketAddr,

    /// A folder of keypair files.
    #[arg(long)]
    wallets: PathBuf,

    /// The Photon indexer of Privacy Rings. With it, the wallet builds shielded spends.
    #[arg(long)]
    ring_indexer: Option<String>,

    #[arg(long, default_value = "http://127.0.0.1:3001")]
    ring_prover: String,

    /// The pool tree that new notes go into. The default is the tree of the Privacy Rings localnet
    /// snapshot.
    #[arg(long, default_value = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor")]
    ring_tree: String,
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Args::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("error: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(args: Args) -> Result<(), String> {
    let ring = match args.ring_indexer.clone() {
        Some(indexer) => {
            let tree = args.ring_tree.parse().map_err(|_| format!("`{}` is not an address", args.ring_tree))?;
            Some(Endpoints { rpc: args.rpc.clone(), indexer, prover: args.ring_prover.clone(), tree })
        }
        None => None,
    };
    let wallet = Arc::new(Wallet::new(Keys::load(&args.wallets)?, Client::new(&args.rpc), ring));

    if wallet.ring.is_some() {
        let registering = Arc::clone(&wallet);
        let registration =
            tokio::task::spawn_blocking(move || registering.register()).await.map_err(|error| error.to_string())?;

        match registration {
            Ok(done) => {
                eprintln!("registered {} keys in Privacy Rings", done.registered);
                done.failures.iter().for_each(|failure| eprintln!("  not registered: {failure}"));
            }
            Err(error) => eprintln!("the Privacy Rings registration failed: {}", error.message),
        }
    }

    let listener = tokio::net::TcpListener::bind(args.listen)
        .await
        .map_err(|error| format!("cannot listen on {}: {error}", args.listen))?;
    eprintln!("sdp-intents-local-wallet on http://{} over {}", args.listen, args.rpc);

    axum::serve(listener, router(wallet))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .map_err(|error| error.to_string())
}
