//! Reads Token-2022 mints and token accounts in place. An account with extensions holds its base
//! state, zero padding to 165 bytes, an account type byte, and then TLV entries: a `u16` type, a
//! `u16` length, and the value. Both numbers are little-endian.

use pinocchio::address::Address;

pub const MINT_LEN: usize = 82;
pub const TOKEN_ACCOUNT_LEN: usize = 165;
const ACCOUNT_TYPE_OFFSET: usize = 165;
const TLV_OFFSET: usize = 166;
const TLV_HEADER_LEN: usize = 4;

const ACCOUNT_TYPE_MINT: u8 = 1;
const ACCOUNT_TYPE_ACCOUNT: u8 = 2;

const MINT_DECIMALS_OFFSET: usize = 44;
const MINT_INITIALIZED_OFFSET: usize = 45;
const ACCOUNT_AMOUNT_OFFSET: usize = 64;
const ACCOUNT_STATE_OFFSET: usize = 108;

/// The extension types of Token-2022 11, as `ExtensionType` numbers them.
pub mod kind {
    pub const TRANSFER_FEE_CONFIG: u16 = 1;
    pub const TRANSFER_FEE_AMOUNT: u16 = 2;
    pub const MINT_CLOSE_AUTHORITY: u16 = 3;
    pub const CONFIDENTIAL_TRANSFER_MINT: u16 = 4;
    pub const CONFIDENTIAL_TRANSFER_ACCOUNT: u16 = 5;
    pub const DEFAULT_ACCOUNT_STATE: u16 = 6;
    pub const IMMUTABLE_OWNER: u16 = 7;
    pub const MEMO_TRANSFER: u16 = 8;
    pub const NON_TRANSFERABLE: u16 = 9;
    pub const INTEREST_BEARING_CONFIG: u16 = 10;
    pub const CPI_GUARD: u16 = 11;
    pub const PERMANENT_DELEGATE: u16 = 12;
    pub const NON_TRANSFERABLE_ACCOUNT: u16 = 13;
    pub const TRANSFER_HOOK: u16 = 14;
    pub const TRANSFER_HOOK_ACCOUNT: u16 = 15;
    pub const CONFIDENTIAL_TRANSFER_FEE_CONFIG: u16 = 16;
    pub const CONFIDENTIAL_TRANSFER_FEE_AMOUNT: u16 = 17;
    pub const METADATA_POINTER: u16 = 18;
    pub const TOKEN_METADATA: u16 = 19;
    pub const GROUP_POINTER: u16 = 20;
    pub const TOKEN_GROUP: u16 = 21;
    pub const GROUP_MEMBER_POINTER: u16 = 22;
    pub const TOKEN_GROUP_MEMBER: u16 = 23;
    pub const CONFIDENTIAL_MINT_BURN: u16 = 24;
    pub const SCALED_UI_AMOUNT: u16 = 25;
    pub const PAUSABLE: u16 = 26;
    pub const PAUSABLE_ACCOUNT: u16 = 27;
    pub const PERMISSIONED_BURN: u16 = 28;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InvalidTokenData;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Extension<'a> {
    pub kind: u16,
    pub value: &'a [u8],
}

/// The TLV entries of an account, in order. A malformed entry yields one error, then the iterator
/// ends.
pub struct Extensions<'a> {
    tlv: &'a [u8],
}

impl<'a> Iterator for Extensions<'a> {
    type Item = Result<Extension<'a>, InvalidTokenData>;

    /// Ends at an `Uninitialized` type, or when fewer bytes than a type remain, as Token-2022 does.
    fn next(&mut self) -> Option<Self::Item> {
        let kind = u16::from_le_bytes(*self.tlv.first_chunk::<2>()?);

        if kind == 0 {
            self.tlv = &[];
            return None;
        }

        let entry = self.entry(kind);
        let entry_len = entry.map_or(self.tlv.len(), |extension| TLV_HEADER_LEN.saturating_add(extension.value.len()));
        self.tlv = self.tlv.get(entry_len..).unwrap_or_default();

        Some(entry)
    }
}

impl<'a> Extensions<'a> {
    fn entry(&self, kind: u16) -> Result<Extension<'a>, InvalidTokenData> {
        let length =
            self.tlv.get(2..TLV_HEADER_LEN).and_then(|bytes| bytes.first_chunk::<2>()).ok_or(InvalidTokenData)?;
        let value_end = TLV_HEADER_LEN.saturating_add(usize::from(u16::from_le_bytes(*length)));
        let value = self.tlv.get(TLV_HEADER_LEN..value_end).ok_or(InvalidTokenData)?;

        Ok(Extension { kind, value })
    }

    /// The value of the first entry of `kind`.
    pub fn find(self, kind: u16) -> Result<Option<&'a [u8]>, InvalidTokenData> {
        self.filter_map(|entry| match entry {
            Ok(extension) if extension.kind == kind => Some(Ok(extension.value)),
            Ok(_) => None,
            Err(error) => Some(Err(error)),
        })
        .next()
        .transpose()
    }
}

/// The TLV data after the base state, or none when the account has no extensions.
fn tlv(data: &[u8], base_len: usize, account_type: u8) -> Result<&[u8], InvalidTokenData> {
    if data.len() == base_len {
        return Ok(&[]);
    }

    if data.get(ACCOUNT_TYPE_OFFSET) != Some(&account_type) {
        return Err(InvalidTokenData);
    }

    data.get(TLV_OFFSET..).ok_or(InvalidTokenData)
}

pub struct Mint<'a> {
    data: &'a [u8],
    tlv: &'a [u8],
}

impl<'a> Mint<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, InvalidTokenData> {
        if data.get(MINT_INITIALIZED_OFFSET) != Some(&1) {
            return Err(InvalidTokenData);
        }

        Ok(Self { data, tlv: tlv(data, MINT_LEN, ACCOUNT_TYPE_MINT)? })
    }

    pub fn decimals(&self) -> Result<u8, InvalidTokenData> {
        self.data.get(MINT_DECIMALS_OFFSET).copied().ok_or(InvalidTokenData)
    }

    pub fn extensions(&self) -> Extensions<'a> {
        Extensions { tlv: self.tlv }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AccountState {
    Uninitialized,
    Initialized,
    Frozen,
}

pub struct TokenAccount<'a> {
    data: &'a [u8],
    tlv: &'a [u8],
}

impl<'a> TokenAccount<'a> {
    pub fn new(data: &'a [u8]) -> Result<Self, InvalidTokenData> {
        if data.len() < TOKEN_ACCOUNT_LEN {
            return Err(InvalidTokenData);
        }

        Ok(Self { data, tlv: tlv(data, TOKEN_ACCOUNT_LEN, ACCOUNT_TYPE_ACCOUNT)? })
    }

    pub fn mint(&self) -> Result<Address, InvalidTokenData> {
        self.data.first_chunk::<32>().map(|bytes| Address::new_from_array(*bytes)).ok_or(InvalidTokenData)
    }

    pub fn amount(&self) -> Result<u64, InvalidTokenData> {
        let bytes = self.data.get(ACCOUNT_AMOUNT_OFFSET..).and_then(|rest| rest.first_chunk::<8>());

        bytes.map(|bytes| u64::from_le_bytes(*bytes)).ok_or(InvalidTokenData)
    }

    pub fn state(&self) -> Result<AccountState, InvalidTokenData> {
        match self.data.get(ACCOUNT_STATE_OFFSET) {
            Some(0) => Ok(AccountState::Uninitialized),
            Some(1) => Ok(AccountState::Initialized),
            Some(2) => Ok(AccountState::Frozen),
            _ => Err(InvalidTokenData),
        }
    }

    pub fn extensions(&self) -> Extensions<'a> {
        Extensions { tlv: self.tlv }
    }
}

#[cfg(test)]
mod tests {
    use core::mem::{offset_of, size_of};

    use spl_token_2022_interface::extension::ExtensionType;
    use spl_token_2022_interface::pod::{PodAccount, PodMint};

    use super::*;

    /// A mint with 6 decimals and two extensions: an empty `NonTransferable`, then a 2-byte value.
    fn mint_with_extensions() -> Vec<u8> {
        let mut data = vec![0; TLV_OFFSET];
        data[MINT_DECIMALS_OFFSET] = 6;
        data[MINT_INITIALIZED_OFFSET] = 1;
        data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_MINT;
        data.extend_from_slice(&[9, 0, 0, 0, 26, 0, 2, 0, 7, 1]);

        data
    }

    #[test]
    fn the_extension_kinds_are_the_token_2022_numbers() {
        let kinds = [
            (kind::TRANSFER_FEE_CONFIG, ExtensionType::TransferFeeConfig),
            (kind::TRANSFER_FEE_AMOUNT, ExtensionType::TransferFeeAmount),
            (kind::MINT_CLOSE_AUTHORITY, ExtensionType::MintCloseAuthority),
            (kind::CONFIDENTIAL_TRANSFER_MINT, ExtensionType::ConfidentialTransferMint),
            (kind::CONFIDENTIAL_TRANSFER_ACCOUNT, ExtensionType::ConfidentialTransferAccount),
            (kind::DEFAULT_ACCOUNT_STATE, ExtensionType::DefaultAccountState),
            (kind::IMMUTABLE_OWNER, ExtensionType::ImmutableOwner),
            (kind::MEMO_TRANSFER, ExtensionType::MemoTransfer),
            (kind::NON_TRANSFERABLE, ExtensionType::NonTransferable),
            (kind::INTEREST_BEARING_CONFIG, ExtensionType::InterestBearingConfig),
            (kind::CPI_GUARD, ExtensionType::CpiGuard),
            (kind::PERMANENT_DELEGATE, ExtensionType::PermanentDelegate),
            (kind::NON_TRANSFERABLE_ACCOUNT, ExtensionType::NonTransferableAccount),
            (kind::TRANSFER_HOOK, ExtensionType::TransferHook),
            (kind::TRANSFER_HOOK_ACCOUNT, ExtensionType::TransferHookAccount),
            (kind::CONFIDENTIAL_TRANSFER_FEE_CONFIG, ExtensionType::ConfidentialTransferFeeConfig),
            (kind::CONFIDENTIAL_TRANSFER_FEE_AMOUNT, ExtensionType::ConfidentialTransferFeeAmount),
            (kind::METADATA_POINTER, ExtensionType::MetadataPointer),
            (kind::TOKEN_METADATA, ExtensionType::TokenMetadata),
            (kind::GROUP_POINTER, ExtensionType::GroupPointer),
            (kind::TOKEN_GROUP, ExtensionType::TokenGroup),
            (kind::GROUP_MEMBER_POINTER, ExtensionType::GroupMemberPointer),
            (kind::TOKEN_GROUP_MEMBER, ExtensionType::TokenGroupMember),
            (kind::CONFIDENTIAL_MINT_BURN, ExtensionType::ConfidentialMintBurn),
            (kind::SCALED_UI_AMOUNT, ExtensionType::ScaledUiAmount),
            (kind::PAUSABLE, ExtensionType::Pausable),
            (kind::PAUSABLE_ACCOUNT, ExtensionType::PausableAccount),
            (kind::PERMISSIONED_BURN, ExtensionType::PermissionedBurn),
        ];

        assert!(kinds.iter().all(|(number, extension)| *number == u16::from(*extension)));
        assert!(ExtensionType::try_from(&(kind::PERMISSIONED_BURN + 1).to_le_bytes()[..]).is_err());
    }

    #[test]
    fn the_base_offsets_are_those_of_the_interface() {
        assert_eq!(size_of::<PodMint>(), MINT_LEN);
        assert_eq!(size_of::<PodAccount>(), TOKEN_ACCOUNT_LEN);
        assert_eq!(offset_of!(PodMint, decimals), MINT_DECIMALS_OFFSET);
        assert_eq!(offset_of!(PodMint, is_initialized), MINT_INITIALIZED_OFFSET);
        assert_eq!(offset_of!(PodAccount, amount), ACCOUNT_AMOUNT_OFFSET);
        assert_eq!(offset_of!(PodAccount, state), ACCOUNT_STATE_OFFSET);
    }

    #[test]
    fn reads_the_extensions_of_a_mint_in_order() {
        let data = mint_with_extensions();
        let mint = Mint::new(&data).unwrap();

        let extensions: Vec<Extension<'_>> = mint.extensions().collect::<Result<_, _>>().unwrap();

        assert_eq!(mint.decimals(), Ok(6));
        assert_eq!(
            extensions,
            [
                Extension { kind: kind::NON_TRANSFERABLE, value: &[] },
                Extension { kind: kind::PAUSABLE, value: &[7, 1] }
            ]
        );
        assert_eq!(mint.extensions().find(kind::PAUSABLE), Ok(Some(&[7, 1][..])));
        assert_eq!(mint.extensions().find(kind::TRANSFER_HOOK), Ok(None));
    }

    #[test]
    fn a_mint_without_extensions_has_none() {
        let mut data = vec![0; MINT_LEN];
        data[MINT_INITIALIZED_OFFSET] = 1;

        assert_eq!(Mint::new(&data).unwrap().extensions().count(), 0);
    }

    #[test]
    fn an_uninitialized_type_ends_the_entries() {
        let mut data = mint_with_extensions();
        data.truncate(TLV_OFFSET);
        data.extend_from_slice(&[0, 0, 9, 9, 26, 0]);

        assert_eq!(Mint::new(&data).unwrap().extensions().count(), 0);
    }

    #[test]
    fn a_value_past_the_data_is_one_error() {
        let mut data = mint_with_extensions();
        data.truncate(TLV_OFFSET);
        data.extend_from_slice(&[26, 0, 9, 0, 1]);

        let entries: Vec<_> = Mint::new(&data).unwrap().extensions().collect();

        assert_eq!(entries, [Err(InvalidTokenData)]);
    }

    #[test]
    fn a_mint_with_the_wrong_account_type_is_invalid() {
        let mut data = mint_with_extensions();
        data[ACCOUNT_TYPE_OFFSET] = ACCOUNT_TYPE_ACCOUNT;

        assert!(Mint::new(&data).is_err());
    }

    #[test]
    fn reads_a_token_account() {
        let mut data = vec![0; TOKEN_ACCOUNT_LEN];
        data[..32].copy_from_slice(&[3; 32]);
        data[ACCOUNT_AMOUNT_OFFSET..ACCOUNT_AMOUNT_OFFSET + 8].copy_from_slice(&500u64.to_le_bytes());
        data[ACCOUNT_STATE_OFFSET] = 2;

        let account = TokenAccount::new(&data).unwrap();

        assert_eq!(account.mint(), Ok(Address::new_from_array([3; 32])));
        assert_eq!(account.amount(), Ok(500));
        assert_eq!(account.state(), Ok(AccountState::Frozen));
        assert_eq!(account.extensions().count(), 0);
    }
}
