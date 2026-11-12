use pinocchio::address::Address;
use sdp_intents_spec::builder::PAYER_RENT_PLACEHOLDER;
use sdp_intents_spec::AccountRole;

/// The rent payer in a built instruction. The service and `verify_intent` put the intent's rent payer
/// in its place.
pub const RENT_PAYER: Address = Address::new_from_array(PAYER_RENT_PLACEHOLDER.0);

/// An account of a built instruction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meta {
    pub address: Address,
    pub role: AccountRole,
}

impl Meta {
    pub fn readonly(address: &Address) -> Self {
        Self { address: *address, role: AccountRole::Readonly }
    }

    pub fn writable(address: &Address) -> Self {
        Self { address: *address, role: AccountRole::Writable }
    }

    pub fn signer(address: &Address) -> Self {
        Self { address: *address, role: AccountRole::ReadonlySigner }
    }

    pub fn writable_signer(address: &Address) -> Self {
        Self { address: *address, role: AccountRole::WritableSigner }
    }

    /// The account that funds a new account: writable, and a signer.
    pub fn rent_payer() -> Self {
        Self::writable_signer(&RENT_PAYER)
    }

    /// An account meta from the flags that instruction crates use, such as those of `spl-token-2022`.
    pub fn new(address: &Address, is_signer: bool, is_writable: bool) -> Self {
        Self { address: *address, role: AccountRole::new(is_writable, is_signer) }
    }
}
