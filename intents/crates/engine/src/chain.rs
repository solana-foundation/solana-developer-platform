use sdp_intents_spec::Address;

/// An account as the engine reads it. An account that does not exist is owned by the System
/// program and has no data, as on the chain.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AccountData<'a> {
    pub owner: &'a Address,
    pub data: &'a [u8],
    pub lamports: u64,
}

/// The accounts that the caller holds. The service backs it with its account cache, and a program
/// with the accounts of its instruction.
pub trait Chain {
    /// `None` means that the caller does not hold the account yet. It never means that the account
    /// does not exist.
    fn account(&self, address: &Address) -> Option<AccountData<'_>>;
}
