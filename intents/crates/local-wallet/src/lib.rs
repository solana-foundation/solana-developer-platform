//! The playground's wallet, which holds the local keypairs so that the intents service holds none.
//! Only the caller talks to it: the page, or the e2e. Only for a local surfnet.
//!
//! | Route | Body | Returns |
//! | :-- | :-- | :-- |
//! | `GET /wallets` | | The keys, by name |
//! | `POST /send` | `{ message, presigned? }` | Checks each Privacy Rings spend, signs, and sends |
//! | `POST /shielded/build` | The `spend` of a `build` | The spend's pool instructions and nullifier accounts, which it records |
//! | `GET /ring`, `POST /ring/shield` | `{ address, lamports }` | Each key's private SOL, and a deposit |

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
    /// Each spend that the wallet built, by its pool instruction's data, which holds the proof.
    built: Mutex<HashMap<Vec<u8>, ShieldedSpend>>,
}

type Shared = State<Arc<Wallet>>;

impl Wallet {
    pub fn new(keys: Keys, client: Client, ring: Option<Endpoints>) -> Self {
        Self { keys, client, ring, built: Mutex::new(HashMap::new()) }
    }
}

pub use spends::Registration;

pub fn router(wallet: Arc<Wallet>) -> Router {
    Router::new()
        .route("/health", get(|| async { "ok" }))
        .route("/wallets", get(|State(wallet): Shared| async move { Json(wallet.keys.json()) }))
        .route("/send", post(|state, body| run(state, body, |wallet, body| wallet.send(&body))))
        .route("/shielded/build", post(|state, body| run(state, body, |wallet, body| wallet.build(&body))))
        .route("/ring", get(|state| run(state, Json(Value::Null), |wallet, _| wallet.balances())))
        .route("/ring/shield", post(|state, body| run(state, body, |wallet, body| wallet.shield(&body))))
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
