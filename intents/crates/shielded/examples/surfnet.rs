//! A private transfer on a surfnet that holds Zolana's programs, with Photon and the prover running.
//! Alice shields 1 SOL and sends Bob 0.25 SOL privately; each wallet then reads its own balance.
//!
//!   cargo run -p sdp-intents-shielded --example surfnet -- <rpc> <indexer> <prover>

use std::str::FromStr as _;
use std::thread::sleep;
use std::time::Duration;

use sdp_intents_shielded::{Endpoints, Shielded, ShieldedWallet};
use solana_address::Address;
use solana_keypair::Keypair;
use spr_client::{sign_transaction, Rpc as _, SolanaRpc};
use spr_transaction::SOL_MINT;

/// The pool tree of Zolana's v0.6.0-alpha localnet snapshot.
const TREE: &str = "777pvSGe5LaBd9nCczvE2FXEauiwtfGJ5XRpjKyniGor";
const SOL: u64 = 1_000_000_000;

type Failure = Box<dyn std::error::Error>;

fn main() -> Result<(), Failure> {
    let arguments: Vec<String> = std::env::args().skip(1).collect();
    let argument = |index: usize, default: &str| arguments.get(index).cloned().unwrap_or_else(|| default.to_owned());
    let endpoints = Endpoints {
        rpc: argument(0, "http://127.0.0.1:18899"),
        indexer: argument(1, "http://127.0.0.1:18784"),
        prover: argument(2, "http://127.0.0.1:13001"),
        tree: Address::from_str(TREE)?,
    };
    let shielded = Shielded::connect(&endpoints);
    let mut airdrops = SolanaRpc::new(endpoints.rpc.clone());

    let alice = ShieldedWallet::from_seed(Keypair::new().secret_bytes())?;
    let bob = ShieldedWallet::from_seed(Keypair::new().secret_bytes())?;
    for (name, wallet) in [("alice", &alice), ("bob", &bob)] {
        airdrops.airdrop(&wallet.address(), 10 * SOL)?;
        shielded.register(wallet)?;
        println!("{name} {} registered", wallet.address());
    }

    shielded.shield_sol(&alice, SOL)?;
    println!("alice private balance: {}", balance_reaching(&shielded, &alice, SOL)?);

    let prepared = shielded.prepare_transfer(&alice, bob.address(), SOL_MINT, SOL / 4)?;
    let transaction = sign_transaction(prepared.message.message, &[alice.funding()])?;
    let signature = shielded.client().rpc().process_transaction(transaction)?;
    shielded.client().confirm_private_transaction_sync(signature)?;
    println!("alice sent bob 0.25 SOL privately: {signature}");

    println!("alice private balance: {}", balance_reaching(&shielded, &alice, 3 * SOL / 4)?);
    println!("bob   private balance: {}", balance_reaching(&shielded, &bob, SOL / 4)?);

    Ok(())
}

/// The wallet's private SOL balance once it reaches `expected`, after the indexer catches up.
fn balance_reaching(shielded: &Shielded, wallet: &ShieldedWallet, expected: u64) -> Result<u64, Failure> {
    for _ in 0..30 {
        let balance = shielded.balance(wallet, SOL_MINT)?;
        if balance == expected {
            return Ok(balance);
        }

        sleep(Duration::from_secs(1));
    }

    Err(format!("the balance did not reach {expected}").into())
}
