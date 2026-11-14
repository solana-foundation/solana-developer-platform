use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

tokio::task_local! {
    /// The calls of the request that the current task serves, when it counts them.
    static REQUEST_CALLS: Arc<Calls>;
}

/// What a future returned, and the RPC calls that its task made.
pub struct Counted<T> {
    pub output: T,
    pub calls: RpcCalls,
}

/// Runs `future`, and counts the RPC calls that it makes. A fetch that another request started
/// counts for that request only, because this one made no call for it. A subscription runs on its
/// own task, so its calls never count here.
pub async fn counted<F: Future>(future: F) -> Counted<F::Output> {
    let calls = Arc::new(Calls::default());
    let output = REQUEST_CALLS.scope(Arc::clone(&calls), future).await;

    Counted { output, calls: calls.snapshot() }
}

/// The RPC calls and the cache reads since the start, for the service's metrics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RpcCalls {
    pub get_multiple_accounts: u64,
    pub simulate_transaction: u64,
    pub get_latest_blockhash: u64,
    pub get_program_accounts: u64,
    pub send_transaction: u64,
    pub get_block_height: u64,
    pub get_signature_statuses: u64,
    /// Accounts that the cache served.
    pub cache_hits: u64,
    /// Accounts that a request fetched, or waited for while another request fetched them.
    pub cache_misses: u64,
    /// Subscriptions that ended and started again.
    pub subscription_restarts: u64,
}

#[derive(Default)]
pub(crate) struct Calls {
    get_multiple_accounts: AtomicU64,
    simulate_transaction: AtomicU64,
    get_latest_blockhash: AtomicU64,
    get_program_accounts: AtomicU64,
    send_transaction: AtomicU64,
    get_block_height: AtomicU64,
    get_signature_statuses: AtomicU64,
    cache_hits: AtomicU64,
    cache_misses: AtomicU64,
    subscription_restarts: AtomicU64,
}

#[derive(Clone, Copy)]
pub(crate) enum Counter {
    GetMultipleAccounts,
    SimulateTransaction,
    GetLatestBlockhash,
    GetProgramAccounts,
    SendTransaction,
    GetBlockHeight,
    GetSignatureStatuses,
    CacheHits,
    CacheMisses,
    SubscriptionRestarts,
}

impl Calls {
    pub(crate) fn count(&self, counter: Counter) {
        self.add(counter, 1);
    }

    /// Adds to the service's counters, and to the current request's, when it counts them.
    pub(crate) fn add(&self, counter: Counter, amount: u64) {
        self.counter(counter).fetch_add(amount, Ordering::Relaxed);

        let _ = REQUEST_CALLS.try_with(|request| request.counter(counter).fetch_add(amount, Ordering::Relaxed));
    }

    pub(crate) fn snapshot(&self) -> RpcCalls {
        let read = |counter| self.counter(counter).load(Ordering::Relaxed);

        RpcCalls {
            get_multiple_accounts: read(Counter::GetMultipleAccounts),
            simulate_transaction: read(Counter::SimulateTransaction),
            get_latest_blockhash: read(Counter::GetLatestBlockhash),
            get_program_accounts: read(Counter::GetProgramAccounts),
            send_transaction: read(Counter::SendTransaction),
            get_block_height: read(Counter::GetBlockHeight),
            get_signature_statuses: read(Counter::GetSignatureStatuses),
            cache_hits: read(Counter::CacheHits),
            cache_misses: read(Counter::CacheMisses),
            subscription_restarts: read(Counter::SubscriptionRestarts),
        }
    }

    fn counter(&self, counter: Counter) -> &AtomicU64 {
        match counter {
            Counter::GetMultipleAccounts => &self.get_multiple_accounts,
            Counter::SimulateTransaction => &self.simulate_transaction,
            Counter::GetLatestBlockhash => &self.get_latest_blockhash,
            Counter::GetProgramAccounts => &self.get_program_accounts,
            Counter::SendTransaction => &self.send_transaction,
            Counter::GetBlockHeight => &self.get_block_height,
            Counter::GetSignatureStatuses => &self.get_signature_statuses,
            Counter::CacheHits => &self.cache_hits,
            Counter::CacheMisses => &self.cache_misses,
            Counter::SubscriptionRestarts => &self.subscription_restarts,
        }
    }
}
