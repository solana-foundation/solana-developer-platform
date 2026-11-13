//! Reads the input that `@sdp/intents-verifier` writes. The crate doc gives the layout.

use sdp_intents_planner::Account;
use sdp_intents_spec::Address;

#[derive(Debug, PartialEq, Eq)]
pub struct Input {
    pub message: Vec<u8>,
    /// Each fetched account, with `None` for one that does not exist.
    pub accounts: Vec<(Address, Option<Account>)>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum InputError {
    /// The input ends before the field that it names.
    Truncated(&'static str),
    /// The input holds bytes after its last account.
    TrailingBytes,
    NotAnAddress(String),
}

impl core::fmt::Display for InputError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            Self::Truncated(field) => write!(f, "the input ends before the {field}"),
            Self::TrailingBytes => f.write_str("the input holds bytes after its last account"),
            Self::NotAnAddress(text) => write!(f, "`{text}` is not a base58 address"),
        }
    }
}

impl Input {
    pub fn parse(bytes: &[u8]) -> Result<Self, InputError> {
        let mut reader = Reader(bytes);
        let message_len = reader.u32("message length")?;
        let message = reader.take(message_len, "message")?.to_vec();
        let count = reader.u32("account count")?;
        let accounts = (0..count).map(|_| reader.account()).collect::<Result<Vec<_>, _>>()?;

        if !reader.0.is_empty() {
            return Err(InputError::TrailingBytes);
        }

        Ok(Self { message, accounts })
    }

    /// `None` when the caller did not fetch `address`, and `Some(None)` when it does not exist.
    pub fn account(&self, address: &Address) -> Option<Option<&Account>> {
        self.accounts.iter().find(|(fetched, _)| fetched == address).map(|(_, account)| account.as_ref())
    }
}

struct Reader<'b>(&'b [u8]);

impl<'b> Reader<'b> {
    fn take(&mut self, len: usize, field: &'static str) -> Result<&'b [u8], InputError> {
        let (taken, rest) = self.0.split_at_checked(len).ok_or(InputError::Truncated(field))?;
        self.0 = rest;

        Ok(taken)
    }

    fn array<const N: usize>(&mut self, field: &'static str) -> Result<[u8; N], InputError> {
        let (taken, rest) = self.0.split_first_chunk::<N>().ok_or(InputError::Truncated(field))?;
        self.0 = rest;

        Ok(*taken)
    }

    fn u32(&mut self, field: &'static str) -> Result<usize, InputError> {
        let value = u32::from_le_bytes(self.array(field)?);

        usize::try_from(value).map_err(|_| InputError::Truncated(field))
    }

    fn address(&mut self, field: &'static str) -> Result<Address, InputError> {
        let [len] = self.array(field)?;
        let text = self.take(usize::from(len), field)?;
        let not_an_address = || InputError::NotAnAddress(String::from_utf8_lossy(text).into_owned());
        let bytes = bs58::decode(text).into_vec().map_err(|_| not_an_address())?;

        Ok(Address(bytes.try_into().map_err(|_| not_an_address())?))
    }

    fn account(&mut self) -> Result<(Address, Option<Account>), InputError> {
        let address = self.address("account address")?;
        let [exists] = self.array("account presence")?;

        if exists == 0 {
            return Ok((address, None));
        }

        let owner = self.address("account owner")?;
        let lamports = u64::from_le_bytes(self.array("account lamports")?);
        let data_len = self.u32("account data length")?;
        let data = self.take(data_len, "account data")?.to_vec();

        Ok((address, Some(Account { owner, lamports, data })))
    }
}
