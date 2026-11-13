//! The service's view of the chain: an account cache over RPC that subscriptions keep current, and
//! the simulations, blockhashes, listings, and sends that the service needs.
//!
//! A cached account is served while a live subscription covers it, and otherwise for at most
//! `max_age`, about one slot. Concurrent requests for one account share one fetch. A failed fetch
//! stores nothing (`AGENTS.md`, "RPC is a budget"). Each subscription holds its own websocket, which
//! is enough for the registry's indexes.
//!
//! Simulations run on the RPC. LiteSVM 0.18 has no v1 transactions, and it pins `solana-address`
//! 2.7, which `solana-message` 6 in this workspace refuses.

mod cache;
mod calls;
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
    pub fn new(rpc_url: &str, ws_url: &str, max_age: Duration) -> Self {
        Self::with_client(
            RpcClient::new_with_commitment(rpc_url.to_owned(), CommitmentConfig::processed()),
            ws_url,
            max_age,
        )
    }

    pub fn with_client(rpc: RpcClient, ws_url: &str, max_age: Duration) -> Self {
        let inner =
            Inner { rpc, ws_url: ws_url.to_owned(), max_age, state: Default::default(), calls: Calls::default() };

        Self { inner: Arc::new(inner) }
    }

    pub fn calls(&self) -> RpcCalls {
        self.inner.calls.snapshot()
    }

    /// Simulates with signatures unchecked and the blockhash replaced, as the client does.
    pub async fn simulate(&self, simulation: &Simulation) -> Result<SimulationResult, ChainError> {
        let transaction = rpc::simulation_transaction(simulation)?;
        self.inner.calls.count(Counter::SimulateTransaction);
        let response =
            self.inner.rpc.simulate_transaction_with_config(&transaction, rpc::simulation_config(simulation)).await?;

        Ok(rpc::simulation_result(response.value)?)
    }

    /// A `confirmed` blockhash, as a signer needs.
    pub async fn latest_blockhash(&self) -> Result<Hash, ChainError> {
        self.inner.calls.count(Counter::GetLatestBlockhash);
        let (blockhash, _) = self.inner.rpc.get_latest_blockhash_with_commitment(CommitmentConfig::confirmed()).await?;

        Ok(blockhash)
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
