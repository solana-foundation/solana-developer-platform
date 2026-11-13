use std::collections::HashMap;

use sdp_intents_engine::{AccountData, Chain};
use sdp_intents_spec::Address;

/// An account as a fetch or a simulation returns it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub owner: Address,
    pub lamports: u64,
    pub data: Vec<u8>,
}

/// The accounts that a caller fetched for the planner. A caller with its own cache can implement
/// `Chain` on the cache instead.
#[derive(Debug, Default)]
pub struct AccountMap {
    accounts: HashMap<Address, Account>,
}

impl AccountMap {
    /// Stores the answer of one `getMultipleAccounts`, in the order of `addresses`. An account that
    /// does not exist is owned by the System program and has no data, as on the chain.
    pub fn insert_fetched(&mut self, addresses: &[Address], accounts: Vec<Option<Account>>) {
        let missing = || Account { owner: Address::default(), lamports: 0, data: Vec::new() };

        self.accounts
            .extend(addresses.iter().copied().zip(accounts.into_iter().map(|account| account.unwrap_or_else(missing))));
    }
}

impl Chain for AccountMap {
    fn account(&self, address: &Address) -> Option<AccountData<'_>> {
        self.accounts.get(address).map(|account| AccountData {
            owner: &account.owner,
            data: &account.data,
            lamports: account.lamports,
        })
    }
}

/// The chain after the earlier segments: the accounts that they changed, over `base`.
pub(crate) struct Overlay<'o, C> {
    pub(crate) after: &'o AccountMap,
    pub(crate) base: &'o C,
}

impl<C: Chain> Chain for Overlay<'_, C> {
    fn account(&self, address: &Address) -> Option<AccountData<'_>> {
        self.after.account(address).or_else(|| self.base.account(address))
    }
}
