//! The accounts that the cache holds, and the fetches in flight. A request that needs an account
//! another request is fetching waits for that fetch, so concurrent requests make one call.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use futures_util::future::{self, BoxFuture, FutureExt as _, Shared};
use solana_commitment_config::CommitmentConfig;

use sdp_intents_client::rpc;
use sdp_intents_planner::Account;
use sdp_intents_spec::Address;

use crate::calls::Counter;
use crate::{CachedRpc, ChainError, Inner};

/// `getMultipleAccounts` takes at most 100 addresses.
const MAX_ACCOUNTS_PER_FETCH: usize = 100;

/// How old a cached account may be.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Freshness {
    /// Under a live subscription, or fetched within `max_age`.
    Live,
    /// Any cached copy of an account that exists. A registry version account never changes while it
    /// exists, and the caller reads the live index that lists it first.
    Published,
}

struct Entry {
    account: Option<Account>,
    slot: u64,
    stored: Instant,
}

type Fetch = Shared<BoxFuture<'static, Result<Arc<Vec<Option<Account>>>, ChainError>>>;

/// The fetch that loads one address, and the address's position in it.
#[derive(Clone)]
struct Pending {
    fetch: Fetch,
    position: usize,
}

enum Source {
    Cached(Option<Account>),
    Pending(Pending),
    /// The position in the fetch that this request starts.
    New(usize),
}

#[derive(Default)]
pub(crate) struct State {
    entries: HashMap<Address, Entry>,
    pending: HashMap<Address, Pending>,
    /// The accounts under a live subscription.
    pub(crate) subscribed: HashSet<Address>,
    /// The accounts that a subscription task follows, live or restarting.
    pub(crate) watched: HashSet<Address>,
}

/// The answer of one `getMultipleAccounts` call or more. `slot` is the lowest context slot.
pub(crate) struct Fetched {
    pub(crate) slot: u64,
    pub(crate) accounts: Vec<Option<Account>>,
}

impl State {
    fn cached(&self, address: &Address, freshness: Freshness, max_age: Duration) -> Option<Option<Account>> {
        let entry = self.entries.get(address)?;
        let fresh = match freshness {
            Freshness::Live => self.subscribed.contains(address) || entry.stored.elapsed() < max_age,
            Freshness::Published => entry.account.is_some(),
        };

        fresh.then(|| entry.account.clone())
    }

    /// Keeps the copy of the higher slot, so a late fetch never replaces a newer notification.
    pub(crate) fn store(&mut self, address: Address, account: Option<Account>, slot: u64) {
        if self.entries.get(&address).is_some_and(|entry| entry.slot > slot) {
            return;
        }

        self.entries.insert(address, Entry { account, slot, stored: Instant::now() });
    }
}

impl CachedRpc {
    /// Each account at `addresses`, in order. `None` is an account that does not exist.
    pub async fn accounts(
        &self,
        addresses: &[Address],
        freshness: Freshness,
    ) -> Result<Vec<Option<Account>>, ChainError> {
        let mut accounts = Vec::with_capacity(addresses.len());

        for source in self.sources(addresses, freshness) {
            let account = match source {
                Source::Cached(account) => account,
                Source::Pending(pending) => {
                    let fetched = pending.fetch.await?;

                    fetched.get(pending.position).cloned().ok_or_else(short_answer)?
                }
                Source::New(_) => return Err(short_answer()),
            };

            accounts.push(account);
        }

        Ok(accounts)
    }

    /// Where each account comes from. The addresses that the cache does not hold and no fetch loads
    /// go in one new fetch, which every later request for them shares.
    fn sources(&self, addresses: &[Address], freshness: Freshness) -> Vec<Source> {
        let mut state = self.inner.state();
        let mut missing: Vec<Address> = Vec::new();

        let sources: Vec<Source> = addresses
            .iter()
            .map(|address| {
                if let Some(account) = state.cached(address, freshness, self.inner.max_age) {
                    return Source::Cached(account);
                }

                if let Some(pending) = state.pending.get(address) {
                    return Source::Pending(pending.clone());
                }

                let position = missing.iter().position(|known| known == address).unwrap_or_else(|| {
                    missing.push(*address);
                    missing.len().saturating_sub(1)
                });

                Source::New(position)
            })
            .collect();

        let hits = sources.iter().filter(|source| matches!(source, Source::Cached(_))).count();
        self.inner.calls.add(Counter::CacheHits, hits as u64);
        self.inner.calls.add(Counter::CacheMisses, sources.len().saturating_sub(hits) as u64);

        if missing.is_empty() {
            return sources;
        }

        let fetch = fetch_and_store(Arc::clone(&self.inner), missing.clone()).boxed().shared();
        let pending = |position| Pending { fetch: fetch.clone(), position };

        state.pending.extend(missing.iter().enumerate().map(|(position, address)| (*address, pending(position))));

        sources
            .into_iter()
            .map(|source| match source {
                Source::New(position) => Source::Pending(pending(position)),
                known => known,
            })
            .collect()
    }
}

impl Inner {
    pub(crate) fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// One `getMultipleAccounts` call for each 100 addresses, all at once.
    pub(crate) async fn fetch(&self, addresses: &[Address]) -> Result<Fetched, ChainError> {
        let calls = addresses.chunks(MAX_ACCOUNTS_PER_FETCH).map(|chunk| {
            let keys: Vec<solana_address::Address> = chunk.iter().copied().map(rpc::solana_address).collect();
            self.calls.count(Counter::GetMultipleAccounts);

            async move { self.rpc.get_multiple_accounts_with_commitment(&keys, CommitmentConfig::processed()).await }
        });
        let responses = future::try_join_all(calls).await?;

        let slot = responses.iter().map(|response| response.context.slot).min().unwrap_or_default();
        let accounts = responses
            .into_iter()
            .flat_map(|response| response.value)
            .map(|account| {
                account.map(|account| Account {
                    owner: Address(account.owner.to_bytes()),
                    lamports: account.lamports,
                    data: account.data,
                })
            })
            .collect();

        Ok(Fetched { slot, accounts })
    }
}

/// The shared fetch. It stores what it fetched, and nothing when it fails.
async fn fetch_and_store(inner: Arc<Inner>, addresses: Vec<Address>) -> Result<Arc<Vec<Option<Account>>>, ChainError> {
    let fetched = inner.fetch(&addresses).await;
    let mut state = inner.state();

    addresses.iter().for_each(|address| {
        state.pending.remove(address);
    });

    let fetched = fetched?;

    for (address, account) in addresses.iter().zip(&fetched.accounts) {
        state.store(*address, account.clone(), fetched.slot);
    }

    Ok(Arc::new(fetched.accounts))
}

fn short_answer() -> ChainError {
    ChainError::Decode("getMultipleAccounts returned fewer accounts than it was asked for".to_owned())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use solana_rpc_client::mock_sender::MocksMap;
    use solana_rpc_client::nonblocking::rpc_client::RpcClient;
    use solana_rpc_client_api::request::RpcRequest;

    use super::*;

    const OWNER: &str = "11111111111111111111111111111111";

    /// An RPC that answers `answers` calls of `getMultipleAccounts`, each with one account. It
    /// answers every later call with `null`, which does not decode.
    fn rpc(answers: usize, max_age: Duration) -> CachedRpc {
        let account = json!({ "lamports": 7, "data": ["AQI=", "base64"], "owner": OWNER, "executable": false, "rentEpoch": 0, "space": 2 });
        let answer = json!({ "context": { "slot": 5 }, "value": [account] });
        let mocks: MocksMap = (0..answers).map(|_| (RpcRequest::GetMultipleAccounts, answer.clone())).collect();

        CachedRpc::with_client(RpcClient::new_mock_with_mocks_map("fails", mocks), "ws://unused", max_age)
    }

    /// The mock answers at once, so the test starts the second request before it awaits the first.
    #[tokio::test]
    async fn concurrent_requests_share_one_fetch() {
        let rpc = rpc(1, Duration::from_secs(60));
        let address = [Address([1; 32])];

        let first = rpc.sources(&address, Freshness::Live);
        let second = rpc.sources(&address, Freshness::Live);
        let [Source::Pending(first), Source::Pending(second)] = [first, second].map(|mut sources| sources.remove(0))
        else {
            panic!("the requests do not wait for a fetch");
        };

        assert_eq!(first.fetch.await.unwrap(), second.fetch.await.unwrap());
        let cached = rpc.accounts(&address, Freshness::Live).await.unwrap();

        assert_eq!(cached.first().cloned().flatten().map(|account| account.data), Some(vec![1, 2]));
        assert_eq!(rpc.calls().get_multiple_accounts, 1);
        assert_eq!((rpc.calls().cache_hits, rpc.calls().cache_misses), (1, 2));
    }

    /// A live read fetches again after `max_age`. A published read keeps the copy.
    #[tokio::test]
    async fn a_live_read_expires_and_a_published_read_does_not() {
        let rpc = rpc(2, Duration::ZERO);
        let address = [Address([1; 32])];

        rpc.accounts(&address, Freshness::Live).await.unwrap();
        rpc.accounts(&address, Freshness::Published).await.unwrap();
        assert_eq!(rpc.calls().get_multiple_accounts, 1);

        rpc.accounts(&address, Freshness::Live).await.unwrap();
        assert_eq!(rpc.calls().get_multiple_accounts, 2);
    }

    /// A failed fetch stores nothing, so the next request fetches again.
    #[tokio::test]
    async fn a_failed_fetch_stores_nothing() {
        let rpc = rpc(0, Duration::from_secs(60));
        let address = [Address([1; 32])];

        assert!(rpc.accounts(&address, Freshness::Live).await.is_err());
        assert!(rpc.accounts(&address, Freshness::Live).await.is_err());
        assert_eq!(rpc.calls().get_multiple_accounts, 2);
    }

    #[test]
    fn a_late_fetch_keeps_the_newer_copy() {
        let mut state = State::default();
        let address = Address([1; 32]);
        let account = |lamports| Some(Account { owner: Address::default(), lamports, data: Vec::new() });

        state.store(address, account(2), 9);
        state.store(address, account(1), 8);

        assert_eq!(state.cached(&address, Freshness::Published, Duration::ZERO), Some(account(2)));
    }
}
