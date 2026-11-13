//! Keeps an account current from an `accountSubscribe` stream. While the stream is live the cache
//! serves the account at any age. When it ends, the account falls back to `max_age`, and the task
//! subscribes again.

use std::sync::Arc;
use std::time::Duration;

use futures_util::StreamExt as _;
use solana_account_decoder_client_types::UiAccountEncoding;
use solana_commitment_config::CommitmentConfig;
use solana_pubsub_client::nonblocking::pubsub_client::PubsubClient;
use solana_rpc_client_api::config::RpcAccountInfoConfig;

use sdp_intents_client::rpc;
use sdp_intents_spec::Address;

use crate::calls::Counter;
use crate::{CachedRpc, ChainError, Inner};

const RESTART_DELAY: Duration = Duration::from_secs(1);

impl CachedRpc {
    /// Starts to follow `address`, once. It needs a Tokio runtime.
    pub fn subscribe(&self, address: Address) {
        if !self.inner.state().watched.insert(address) {
            return;
        }

        tokio::spawn(watch(Arc::clone(&self.inner), address));
    }
}

async fn watch(inner: Arc<Inner>, address: Address) {
    loop {
        let ended = follow(&inner, address).await;
        inner.state().subscribed.remove(&address);
        inner.calls.count(Counter::SubscriptionRestarts);

        if let Err(error) = ended {
            eprintln!("the subscription to {} ended: {error}", rpc::base58(address));
        }

        tokio::time::sleep(RESTART_DELAY).await;
    }
}

/// Subscribes, then fetches once, so that the cache also holds a change from before the stream
/// started. Returns when the stream ends.
async fn follow(inner: &Inner, address: Address) -> Result<(), ChainError> {
    let client = PubsubClient::new(inner.ws_url.as_str()).await.map_err(|error| ChainError::Rpc(error.to_string()))?;
    let config = RpcAccountInfoConfig {
        encoding: Some(UiAccountEncoding::Base64),
        commitment: Some(CommitmentConfig::processed()),
        ..RpcAccountInfoConfig::default()
    };
    let (mut updates, _unsubscribe) = client
        .account_subscribe(&rpc::solana_address(address), Some(config))
        .await
        .map_err(|error| ChainError::Rpc(error.to_string()))?;

    let fetched = inner.fetch(&[address]).await?;
    {
        let mut state = inner.state();
        state.store(address, fetched.accounts.into_iter().next().flatten(), fetched.slot);
        state.subscribed.insert(address);
    }

    while let Some(update) = updates.next().await {
        let account = rpc::ui_account(&update.value)?;
        let exists = account.lamports > 0;

        inner.state().store(address, exists.then_some(account), update.context.slot);
    }

    Ok(())
}
