//! The service's view of the chain: an account cache over RPC that subscriptions keep current, and
//! the simulations, blockhashes, listings, and sends that the service needs.
//!
//! A cached account is served while a live subscription covers it, and otherwise for at most
//! `max_age`, about one slot. Concurrent requests for one account share one fetch. A failed fetch
//! stores nothing (`AGENTS.md`, "RPC is a budget"). Each subscription holds its own websocket, which
//! is enough for the registry's indexes.
//!
//! Simulations run in process, in LiteSVM over the cache (`simulator.rs`), or on the RPC.

mod cache;
mod calls;
mod simulator;
mod subscriptions;

use std::sync::Arc;
use std::time::Duration;

use solana_account_decoder_client_types::UiAccountEncoding;
use solana_commitment_config::CommitmentConfig;
use solana_hash::Hash;
use solana_rpc_client::nonblocking::rpc_client::RpcClient;
use solana_rpc_client_api::config::{RpcAccountInfoConfig, RpcProgramAccountsConfig};
use solana_rpc_client_api::filter::{Memcmp, RpcFilterType};
use solana_signature::Signature;
use solana_transaction::versioned::VersionedTransaction;

use sdp_intents_client::rpc;
use sdp_intents_planner::{Account, Simulation, SimulationResult};
use sdp_intents_spec::Address;

use crate::cache::State;
use crate::calls::{Calls, Counter};

pub use crate::cache::Freshness;
pub use crate::calls::RpcCalls;

/// About one slot.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_millis(400);

/// A blockhash serves plans for about 5 slots. It stays valid for about 150 blocks, so a plan
/// keeps most of its time to be signed.
pub const BLOCKHASH_MAX_AGE: Duration = Duration::from_secs(2);

/// A `confirmed` blockhash, and the last block height at which a transaction can use it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RecentBlockhash {
    pub blockhash: Hash,
    pub last_valid_block_height: u64,
}

struct CachedBlockhash {
    fetched: std::time::Instant,
    recent: RecentBlockhash,
}

#[derive(Clone)]
pub struct CachedRpc {
    inner: Arc<Inner>,
}

pub(crate) struct Inner {
    rpc: RpcClient,
    ws_url: String,
    max_age: Duration,
    state: std::sync::Mutex<State>,
    calls: Calls,
    simulator: Option<simulator::Simulator>,
    /// Held while a fetch runs, so that requests at once share one call.
    blockhash: tokio::sync::Mutex<Option<CachedBlockhash>>,
}

/// Where a simulation runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SimulateIn {
    /// LiteSVM in this process, over the cache.
    Process,
    /// `simulateTransaction` on the RPC.
    Rpc,
}

/// An account that a listing returned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProgramAccount {
    pub address: Address,
    pub account: Account,
}

/// A failed RPC call, as text, so that every request that shares a fetch gets the same error.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChainError {
    Rpc(String),
    /// The RPC answer does not decode, or a transaction does not compile.
    Decode(String),
}

impl CachedRpc {
    /// Reads at `processed`. `ws_url` serves the subscriptions.
    pub fn new(rpc_url: &str, ws_url: &str, max_age: Duration, simulate_in: SimulateIn) -> Self {
        let rpc = RpcClient::new_with_commitment(rpc_url.to_owned(), CommitmentConfig::processed());

        Self::with_client(rpc, ws_url, max_age, simulate_in)
    }

    pub fn with_client(rpc: RpcClient, ws_url: &str, max_age: Duration, simulate_in: SimulateIn) -> Self {
        let inner = Inner {
            rpc,
            ws_url: ws_url.to_owned(),
            max_age,
            state: Default::default(),
            calls: Calls::default(),
            simulator: (simulate_in == SimulateIn::Process).then(simulator::Simulator::new),
            blockhash: tokio::sync::Mutex::new(None),
        };

        Self { inner: Arc::new(inner) }
    }

    pub fn calls(&self) -> RpcCalls {
        self.inner.calls.snapshot()
    }

    /// Simulates on the RPC with signatures unchecked and the blockhash replaced, as the client does.
    async fn simulate_on_rpc(&self, simulation: &Simulation) -> Result<SimulationResult, ChainError> {
        let transaction = rpc::simulation_transaction(simulation)?;
        self.inner.calls.count(Counter::SimulateTransaction);
        let response =
            self.inner.rpc.simulate_transaction_with_config(&transaction, rpc::simulation_config(simulation)).await?;

        Ok(rpc::simulation_result(response.value)?)
    }

    /// A `confirmed` blockhash, as a signer needs, at most [`BLOCKHASH_MAX_AGE`] old.
    pub async fn latest_blockhash(&self) -> Result<RecentBlockhash, ChainError> {
        let mut cached = self.inner.blockhash.lock().await;

        if let Some(cached) = cached.as_ref().filter(|cached| cached.fetched.elapsed() < BLOCKHASH_MAX_AGE) {
            return Ok(cached.recent);
        }

        self.inner.calls.count(Counter::GetLatestBlockhash);
        let (blockhash, last_valid_block_height) =
            self.inner.rpc.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed()).await?;
        let recent = RecentBlockhash { blockhash, last_valid_block_height };
        *cached = Some(CachedBlockhash { fetched: std::time::Instant::now(), recent });

        Ok(recent)
    }

    /// Every account of `program` whose data starts with `discriminator`. The cache does not hold
    /// them.
    pub async fn program_accounts(
        &self,
        program: &Address,
        discriminator: &[u8],
    ) -> Result<Vec<ProgramAccount>, ChainError> {
        let config = RpcProgramAccountsConfig {
            filters: Some(vec![RpcFilterType::Memcmp(Memcmp::new_base58_encoded(0, discriminator))]),
            account_config: RpcAccountInfoConfig {
                encoding: Some(UiAccountEncoding::Base64),
                commitment: Some(CommitmentConfig::processed()),
                ..RpcAccountInfoConfig::default()
            },
            ..RpcProgramAccountsConfig::default()
        };
        self.inner.calls.count(Counter::GetProgramAccounts);
        let listed = self.inner.rpc.get_program_ui_accounts_with_config(&rpc::solana_address(*program), config).await?;

        listed
            .iter()
            .map(|(key, account)| {
                Ok(ProgramAccount { address: Address(key.to_bytes()), account: rpc::ui_account(account)? })
            })
            .collect()
    }

    /// Sends a signed transaction and waits until it is confirmed.
    pub async fn send(&self, transaction: &VersionedTransaction) -> Result<Signature, ChainError> {
        self.inner.calls.count(Counter::SendTransaction);

        Ok(self.inner.rpc.send_and_confirm_transaction(transaction).await?)
    }
}

impl From<solana_rpc_client_api::client_error::Error> for ChainError {
    fn from(error: solana_rpc_client_api::client_error::Error) -> Self {
        Self::Rpc(error.to_string())
    }
}

impl From<sdp_intents_client::ClientError> for ChainError {
    fn from(error: sdp_intents_client::ClientError) -> Self {
        Self::Decode(error.to_string())
    }
}

impl core::fmt::Display for ChainError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Rpc(error) => write!(f, "the RPC call failed: {error}"),
            Self::Decode(error) => write!(f, "the RPC answer does not decode: {error}"),
        }
    }
}

impl std::error::Error for ChainError {}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use solana_rpc_client::mock_sender::MocksMap;
    use solana_rpc_client_api::request::RpcRequest;

    use super::*;

    /// Two plans within the age share one `getLatestBlockhash`.
    #[tokio::test]
    async fn plans_share_a_recent_blockhash() {
        let answer = json!({ "context": { "slot": 1 }, "value": { "blockhash": Hash::new_from_array([7; 32]).to_string(), "lastValidBlockHeight": 150 } });
        let mocks: MocksMap = [(RpcRequest::GetLatestBlockhash, answer)].into_iter().collect();
        let rpc = CachedRpc::with_client(
            RpcClient::new_mock_with_mocks_map("fails", mocks),
            "ws://unused",
            DEFAULT_MAX_AGE,
            SimulateIn::Rpc,
        );

        let first = rpc.latest_blockhash().await.unwrap();
        let second = rpc.latest_blockhash().await.unwrap();

        assert_eq!(first, second);
        assert_eq!(first.last_valid_block_height, 150);
        assert_eq!(rpc.calls().get_latest_blockhash, 1);
    }
}
