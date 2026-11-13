//! The Lighthouse instructions that the assertions use, in the borsh layout of Lighthouse 2.0.0,
//! which is immutable on mainnet.

use alloc::vec;
use alloc::vec::Vec;

use sdp_intents_spec::{AccountRole, Address};

/// `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`.
pub const LIGHTHOUSE_PROGRAM: Address = Address([
    4, 223, 173, 121, 98, 255, 177, 221, 146, 93, 10, 159, 181, 230, 208, 12, 230, 25, 91, 168, 187, 58, 145, 253, 7,
    239, 152, 96, 197, 233, 123, 184,
]);
const SYSTEM_PROGRAM: Address = Address([0; 32]);

const MEMORY_WRITE: u8 = 0;
const MEMORY_CLOSE: u8 = 1;
const ASSERT_ACCOUNT_DELTA: u8 = 4;
const ASSERT_TOKEN_ACCOUNT: u8 = 9;

const LOG_SILENT: u8 = 0;
const GREATER_THAN_OR_EQUAL: u8 = 4;
const EQUAL: u8 = 0;

const WRITE_ACCOUNT_DATA: u8 = 0;
const WRITE_ACCOUNT_INFO_FIELD: u8 = 1;
const FIELD_LAMPORTS: u8 = 1;
const DELTA_ACCOUNT_INFO: u8 = 0;
const DELTA_DATA: u8 = 1;
const DELTA_LAMPORTS: u8 = 0;
const DELTA_U64: u8 = 6;
const DELTA_BYTES: u8 = 8;
const TOKEN_AMOUNT: u8 = 2;
const TOKEN_DELEGATE: u8 = 3;
const TOKEN_DELEGATED_AMOUNT: u8 = 6;
const LESS_THAN_OR_EQUAL: u8 = 5;
/// The borsh tags of `None` and `Some`.
const NONE: u8 = 0;
const SOME: u8 = 1;

/// The token amount is at byte 64 of an SPL Token or Token-2022 account.
pub(crate) const TOKEN_AMOUNT_OFFSET: u16 = 64;

/// A Lighthouse instruction. Its program is [`LIGHTHOUSE_PROGRAM`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LighthouseInstruction {
    pub accounts: Vec<Meta>,
    pub data: Vec<u8>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Meta {
    pub address: Address,
    pub role: AccountRole,
}

/// Lighthouse's memory PDA of the fee payer and `id`, which the snapshots write.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Memory {
    pub address: Address,
    pub id: u8,
    pub bump: u8,
}

/// What a snapshot copies into memory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Source {
    AccountData { offset: u16, len: u16 },
    Lamports,
}

impl Memory {
    /// The memory PDA: the seeds `memory`, the payer, and `id`, under Lighthouse.
    pub fn find(payer: &Address, id: u8) -> Option<Self> {
        let program = solana_address::Address::new_from_array(LIGHTHOUSE_PROGRAM.0);
        let (address, bump) =
            solana_address::Address::try_find_program_address(&[b"memory", &payer.0, &[id]], &program)?;

        Some(Self { address: Address(address.to_bytes()), id, bump })
    }

    /// Copies `source` of `account` to `offset` in memory. The first write creates memory, paid by
    /// `payer`, at the size that the write needs.
    pub(crate) fn write(
        &self,
        payer: &Address,
        account: &Address,
        offset: u64,
        source: Source,
    ) -> LighthouseInstruction {
        let source = match source {
            Source::AccountData { offset, len } => {
                [&[WRITE_ACCOUNT_DATA][..], &offset.to_le_bytes(), &len.to_le_bytes()].concat()
            }
            Source::Lamports => vec![WRITE_ACCOUNT_INFO_FIELD, FIELD_LAMPORTS],
        };

        LighthouseInstruction {
            accounts: vec![
                readonly(&LIGHTHOUSE_PROGRAM),
                readonly(&SYSTEM_PROGRAM),
                Meta { address: *payer, role: AccountRole::WritableSigner },
                Meta { address: self.address, role: AccountRole::Writable },
                readonly(account),
            ],
            data: [&[MEMORY_WRITE, self.id, self.bump][..], &leb128(offset), &source].concat(),
        }
    }

    /// Closes memory and returns its rent to `payer`.
    pub(crate) fn close(&self, payer: &Address) -> LighthouseInstruction {
        LighthouseInstruction {
            accounts: vec![
                readonly(&LIGHTHOUSE_PROGRAM),
                Meta { address: *payer, role: AccountRole::WritableSigner },
                Meta { address: self.address, role: AccountRole::Writable },
            ],
            data: vec![MEMORY_CLOSE, self.id, self.bump],
        }
    }

    /// Fails unless the lamports of `account` changed by at least `min_change` since the snapshot at
    /// `offset`.
    pub(crate) fn lamports_change(&self, account: &Address, offset: u64, min_change: i128) -> LighthouseInstruction {
        let assertion = [
            &[DELTA_ACCOUNT_INFO][..],
            &leb128(offset),
            &[DELTA_LAMPORTS],
            &min_change.to_le_bytes(),
            &[GREATER_THAN_OR_EQUAL],
        ]
        .concat();

        self.delta(account, &assertion)
    }

    /// Fails unless the token amount of `account` changed by at least `min_change` since the
    /// snapshot at `offset`.
    pub(crate) fn amount_change(&self, account: &Address, offset: u64, min_change: i128) -> LighthouseInstruction {
        let assertion = [
            &[DELTA_DATA][..],
            &leb128(offset),
            &leb128(u64::from(TOKEN_AMOUNT_OFFSET)),
            &[DELTA_U64],
            &min_change.to_le_bytes(),
            &[GREATER_THAN_OR_EQUAL],
        ]
        .concat();

        self.delta(account, &assertion)
    }

    /// Fails unless `len` bytes of `account` at `data_offset` equal the snapshot at `offset`.
    pub(crate) fn bytes_unchanged(
        &self,
        account: &Address,
        offset: u64,
        data_offset: u16,
        len: u16,
    ) -> LighthouseInstruction {
        let assertion = [
            &[DELTA_DATA][..],
            &leb128(offset),
            &leb128(u64::from(data_offset)),
            &[DELTA_BYTES],
            &len.to_le_bytes(),
            &[EQUAL],
        ]
        .concat();

        self.delta(account, &assertion)
    }

    fn delta(&self, account: &Address, assertion: &[u8]) -> LighthouseInstruction {
        LighthouseInstruction {
            accounts: vec![readonly(&self.address), readonly(account)],
            data: [&[ASSERT_ACCOUNT_DELTA, LOG_SILENT][..], assertion].concat(),
        }
    }
}

/// Fails unless the token account holds at least `min`. It needs no snapshot.
pub(crate) fn amount_at_least(account: &Address, min: u64) -> LighthouseInstruction {
    LighthouseInstruction {
        accounts: vec![readonly(account)],
        data: [&[ASSERT_TOKEN_ACCOUNT, LOG_SILENT, TOKEN_AMOUNT][..], &min.to_le_bytes(), &[GREATER_THAN_OR_EQUAL]]
            .concat(),
    }
}

/// Fails unless the token account's delegate is `delegate`, or it has none when `delegate` is
/// `None`.
pub(crate) fn delegate_is(account: &Address, delegate: Option<&Address>) -> LighthouseInstruction {
    let value: Vec<u8> = match delegate {
        Some(delegate) => [&[SOME][..], &delegate.0].concat(),
        None => vec![NONE],
    };

    LighthouseInstruction {
        accounts: vec![readonly(account)],
        data: [&[ASSERT_TOKEN_ACCOUNT, LOG_SILENT, TOKEN_DELEGATE][..], &value, &[EQUAL]].concat(),
    }
}

/// Fails unless the token account's delegate may take at most `max`.
pub(crate) fn delegated_at_most(account: &Address, max: u64) -> LighthouseInstruction {
    LighthouseInstruction {
        accounts: vec![readonly(account)],
        data: [
            &[ASSERT_TOKEN_ACCOUNT, LOG_SILENT, TOKEN_DELEGATED_AMOUNT][..],
            &max.to_le_bytes(),
            &[LESS_THAN_OR_EQUAL],
        ]
        .concat(),
    }
}

fn readonly(address: &Address) -> Meta {
    Meta { address: *address, role: AccountRole::Readonly }
}

/// The unsigned LEB128 of `value`: 7 bits a byte, low bits first, with the top bit set on every
/// byte but the last.
fn leb128(mut value: u64) -> Vec<u8> {
    let mut bytes = Vec::new();

    loop {
        let low = (value & 0x7f) as u8;
        value >>= 7;

        if value == 0 {
            bytes.push(low);
            return bytes;
        }

        bytes.push(low | 0x80);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_leb128() {
        assert_eq!(leb128(0), [0]);
        assert_eq!(leb128(64), [64]);
        assert_eq!(leb128(300), [0xac, 0x02]);
    }

    #[test]
    fn the_constant_is_lighthouse() {
        let lighthouse = solana_address::Address::from_str_const("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");

        assert_eq!(LIGHTHOUSE_PROGRAM.0, lighthouse.to_bytes());
    }
}
