//! The playground's wallet, which holds the local keypairs so that the intents service holds none.
//! Only the caller talks to it: the page, or the e2e. Only for a local surfnet.
//!
//! | Route | Body | Returns |
//! | :-- | :-- | :-- |
//! | `GET /wallets` | | The keys, by name |
//! | `POST /send` | `{ message, presigned? }` | Checks each Privacy Rings spend, signs, and sends |
//! | `POST /shielded/build` | `{ spend, prover }`: the `spend` of a `build`, and `wallet` or `service` | The spend's pool instructions and nullifier accounts, which it records |
//! | `GET /ring`, `POST /ring/shield` | `{ address, lamports }` | Each key's private balances, and a deposit of SOL |
//! | `POST /ring/asset` | `{ payer, mint }` | Creates the pool's SPL interface for a mint, on the local surfnet |

mod error;
mod keys;
mod send;
mod spends;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use axum::extract::State;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::Value;

use sdp_intents_client::Client;
use sdp_intents_planner::ShieldedSpend;
use sdp_intents_privacy_rings::Endpoints;

pub use error::WalletError;
pub use keys::Keys;

pub struct Wallet {
    pub keys: Keys,
    pub client: Client,
    pub ring: Option<Endpoints>,
    /// The intents service's prover route, for a build that proves on the service.
    pub service_prover: String,
    /// Each spend that the wallet built and has not signed yet, by the fingerprint of its whole pool
    /// instruction: program, accounts, and data.
    built: Mutex<HashMap<Vec<u8>, ShieldedSpend>>,
    /// The SPL mints that the ring takes, whose private balances `/ring` reads.
    assets: Mutex<Vec<solana_address::Address>>,
}

type Shared = State<Arc<Wallet>>;

impl Wallet {
    pub fn new(keys: Keys, client: Client, ring: Option<Endpoints>, service_prover: String) -> Self {
        Self { keys, client, ring, service_prover, built: Mutex::new(HashMap::new()), assets: Mutex::new(Vec::new()) }
    }
}

pub use spends::Registration;

/// The program, then each account with its role, then the data. Two instructions with the same
/// data and other accounts differ, such as a deposit from another key.
pub(crate) fn fingerprint(instruction: &sdp_intents_planner::Instruction) -> Vec<u8> {
    let accounts = instruction.accounts.iter().flat_map(|meta| meta.address.0.into_iter().chain([u8::from(meta.role)]));

    instruction.program.0.into_iter().chain(accounts).chain(instruction.data.iter().copied()).collect()
}

pub fn router(wallet: Arc<Wallet>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/wallets", get(|State(wallet): Shared| async move { Json(wallet.keys.json()) }))
        .route("/send", post(|state, body| run(state, body, |wallet, body| wallet.send(&body))))
        .route("/shielded/build", post(|state, body| run(state, body, |wallet, body| wallet.build(&body))))
        .route("/ring", get(|state| run(state, Json(Value::Null), |wallet, _| wallet.balances())))
        .route("/ring/shield", post(|state, body| run(state, body, |wallet, body| wallet.shield(&body))))
        .route("/ring/asset", post(|state, body| run(state, body, |wallet, body| wallet.register_asset(&body))))
        .with_state(wallet)
}

/// Runs `work` off the async runtime, because the client and the Privacy Rings SDK block.
async fn run(
    State(wallet): Shared,
    Json(body): Json<Value>,
    work: impl FnOnce(&Wallet, Value) -> Result<Value, WalletError> + Send + 'static,
) -> Response {
    let joined = tokio::task::spawn_blocking(move || work(&wallet, body)).await;

    match joined {
        Ok(Ok(value)) => Json(value).into_response(),
        Ok(Err(error)) => error.into_response(),
        Err(error) => WalletError::failed("wallet", error.to_string()).into_response(),
    }
}
