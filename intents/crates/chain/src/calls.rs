use std::sync::atomic::{AtomicU64, Ordering};

/// The RPC calls and the cache reads since the start, for the service's metrics.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RpcCalls {
    pub get_multiple_accounts: u64,
    pub simulate_transaction: u64,
    pub get_latest_blockhash: u64,
    pub get_program_accounts: u64,
    pub send_transaction: u64,
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
    CacheHits,
    CacheMisses,
    SubscriptionRestarts,
}

impl Calls {
    pub(crate) fn count(&self, counter: Counter) {
        self.add(counter, 1);
    }

    pub(crate) fn add(&self, counter: Counter, amount: u64) {
        self.counter(counter).fetch_add(amount, Ordering::Relaxed);
    }

    pub(crate) fn snapshot(&self) -> RpcCalls {
        let read = |counter| self.counter(counter).load(Ordering::Relaxed);

        RpcCalls {
            get_multiple_accounts: read(Counter::GetMultipleAccounts),
            simulate_transaction: read(Counter::SimulateTransaction),
            get_latest_blockhash: read(Counter::GetLatestBlockhash),
            get_program_accounts: read(Counter::GetProgramAccounts),
            send_transaction: read(Counter::SendTransaction),
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
            Counter::CacheHits => &self.cache_hits,
            Counter::CacheMisses => &self.cache_misses,
            Counter::SubscriptionRestarts => &self.subscription_restarts,
        }
    }
}
