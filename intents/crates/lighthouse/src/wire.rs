//! The Lighthouse instructions that the assertions use, in the borsh layout of Lighthouse 2.0.0,
//! which is immutable on mainnet.

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

/// The most accounts of an instruction here: a memory write.
const MAX_ACCOUNTS: usize = 5;
/// The most data of an instruction here is 37 bytes: a delegate check that names the delegate.
const MAX_DATA: usize = 48;

/// A Lighthouse instruction. Its program is [`LIGHTHOUSE_PROGRAM`]. It lives on the stack, so a
/// program builds one with no allocation. A write past `MAX_DATA` leaves it with no data, so it
/// matches no instruction of a transaction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LighthouseInstruction {
    accounts: [Meta; MAX_ACCOUNTS],
    accounts_len: usize,
    data: [u8; MAX_DATA],
    /// `None` after a write past `MAX_DATA`.
    data_len: Option<usize>,
}

impl LighthouseInstruction {
    fn new(accounts: &[Meta]) -> Self {
        let mut stored = [readonly(&SYSTEM_PROGRAM); MAX_ACCOUNTS];
        let accounts_len = stored.iter_mut().zip(accounts).map(|(slot, meta)| *slot = *meta).count();

        Self { accounts: stored, accounts_len, data: [0; MAX_DATA], data_len: Some(0) }
    }

    pub fn accounts(&self) -> &[Meta] {
        self.accounts.get(..self.accounts_len).unwrap_or_default()
    }

    pub fn data(&self) -> &[u8] {
        self.data_len.and_then(|len| self.data.get(..len)).unwrap_or_default()
    }

    fn bytes(&mut self, bytes: &[u8]) -> &mut Self {
        let start = self.data_len;
        let end = start.and_then(|start| start.checked_add(bytes.len()));
        let slot = start.zip(end).and_then(|(start, end)| self.data.get_mut(start..end));

        self.data_len = slot.map(|slot| slot.copy_from_slice(bytes)).and(end);

        self
    }

    /// The unsigned LEB128 of `value`: 7 bits a byte, low bits first, with the top bit set on
    /// every byte but the last.
    fn leb128(&mut self, value: u64) -> &mut Self {
        let groups = u64::BITS.saturating_sub(value.leading_zeros()).div_ceil(7).max(1);
        let mut bytes = [0u8; 10];

        for (slot, group) in bytes.iter_mut().zip(0..groups) {
            let low = value.checked_shr(group.saturating_mul(7)).unwrap_or(0) as u8 & 0x7f;
            *slot = if group.saturating_add(1) < groups { low | 0x80 } else { low };
        }

        self.bytes(bytes.get(..groups as usize).unwrap_or_default())
    }
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
        let accounts = [
            readonly(&LIGHTHOUSE_PROGRAM),
            readonly(&SYSTEM_PROGRAM),
            Meta { address: *payer, role: AccountRole::WritableSigner },
            Meta { address: self.address, role: AccountRole::Writable },
            readonly(account),
        ];
        let mut instruction = LighthouseInstruction::new(&accounts);
        instruction.bytes(&[MEMORY_WRITE, self.id, self.bump]).leb128(offset);

        match source {
            Source::AccountData { offset, len } => {
                instruction.bytes(&[WRITE_ACCOUNT_DATA]).bytes(&offset.to_le_bytes()).bytes(&len.to_le_bytes())
            }
            Source::Lamports => instruction.bytes(&[WRITE_ACCOUNT_INFO_FIELD, FIELD_LAMPORTS]),
        };

        instruction
    }

    /// Closes memory and returns its rent to `payer`.
    pub(crate) fn close(&self, payer: &Address) -> LighthouseInstruction {
        let accounts = [
            readonly(&LIGHTHOUSE_PROGRAM),
            Meta { address: *payer, role: AccountRole::WritableSigner },
            Meta { address: self.address, role: AccountRole::Writable },
        ];
        let mut instruction = LighthouseInstruction::new(&accounts);
        instruction.bytes(&[MEMORY_CLOSE, self.id, self.bump]);

        instruction
    }

    /// Fails unless the lamports of `account` changed by at least `min_change` since the snapshot at
    /// `offset`.
    pub(crate) fn lamports_change(&self, account: &Address, offset: u64, min_change: i128) -> LighthouseInstruction {
        let mut instruction = self.delta(account);
        instruction
            .bytes(&[DELTA_ACCOUNT_INFO])
            .leb128(offset)
            .bytes(&[DELTA_LAMPORTS])
            .bytes(&min_change.to_le_bytes())
            .bytes(&[GREATER_THAN_OR_EQUAL]);

        instruction
    }

    /// Fails unless the token amount of `account` changed by at least `min_change` since the
    /// snapshot at `offset`.
    pub(crate) fn amount_change(&self, account: &Address, offset: u64, min_change: i128) -> LighthouseInstruction {
        let mut instruction = self.delta(account);
        instruction
            .bytes(&[DELTA_DATA])
            .leb128(offset)
            .leb128(u64::from(TOKEN_AMOUNT_OFFSET))
            .bytes(&[DELTA_U64])
            .bytes(&min_change.to_le_bytes())
            .bytes(&[GREATER_THAN_OR_EQUAL]);

        instruction
    }

    /// Fails unless `len` bytes of `account` at `data_offset` equal the snapshot at `offset`.
    pub(crate) fn bytes_unchanged(
        &self,
        account: &Address,
        offset: u64,
        data_offset: u16,
        len: u16,
    ) -> LighthouseInstruction {
        let mut instruction = self.delta(account);
        instruction
            .bytes(&[DELTA_DATA])
            .leb128(offset)
            .leb128(u64::from(data_offset))
            .bytes(&[DELTA_BYTES])
            .bytes(&len.to_le_bytes())
            .bytes(&[EQUAL]);

        instruction
    }

    fn delta(&self, account: &Address) -> LighthouseInstruction {
        let mut instruction = LighthouseInstruction::new(&[readonly(&self.address), readonly(account)]);
        instruction.bytes(&[ASSERT_ACCOUNT_DELTA, LOG_SILENT]);

        instruction
    }
}

/// Fails unless the token account holds at least `min`. It needs no snapshot.
pub(crate) fn amount_at_least(account: &Address, min: u64) -> LighthouseInstruction {
    let mut instruction = LighthouseInstruction::new(&[readonly(account)]);
    instruction
        .bytes(&[ASSERT_TOKEN_ACCOUNT, LOG_SILENT, TOKEN_AMOUNT])
        .bytes(&min.to_le_bytes())
        .bytes(&[GREATER_THAN_OR_EQUAL]);

    instruction
}

/// Fails unless the token account's delegate is `delegate`, or it has none when `delegate` is
/// `None`.
pub(crate) fn delegate_is(account: &Address, delegate: Option<&Address>) -> LighthouseInstruction {
    let mut instruction = LighthouseInstruction::new(&[readonly(account)]);
    instruction.bytes(&[ASSERT_TOKEN_ACCOUNT, LOG_SILENT, TOKEN_DELEGATE]);

    match delegate {
        Some(delegate) => instruction.bytes(&[SOME]).bytes(&delegate.0),
        None => instruction.bytes(&[NONE]),
    }
    .bytes(&[EQUAL]);

    instruction
}

/// Fails unless the token account's delegate may take at most `max`.
pub(crate) fn delegated_at_most(account: &Address, max: u64) -> LighthouseInstruction {
    let mut instruction = LighthouseInstruction::new(&[readonly(account)]);
    instruction
        .bytes(&[ASSERT_TOKEN_ACCOUNT, LOG_SILENT, TOKEN_DELEGATED_AMOUNT])
        .bytes(&max.to_le_bytes())
        .bytes(&[LESS_THAN_OR_EQUAL]);

    instruction
}

fn readonly(address: &Address) -> Meta {
    Meta { address: *address, role: AccountRole::Readonly }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_leb128() {
        let leb128 = |value| {
            let mut instruction = LighthouseInstruction::new(&[]);
            instruction.leb128(value);

            instruction
        };

        assert_eq!(leb128(0).data(), [0]);
        assert_eq!(leb128(64).data(), [64]);
        assert_eq!(leb128(300).data(), [0xac, 0x02]);
    }

    /// The longest instruction fits, and a write past the buffer leaves no data.
    #[test]
    fn the_longest_instruction_fits() {
        let memory = Memory { address: Address([1; 32]), id: 0, bump: 255 };
        let amount = memory.amount_change(&Address([2; 32]), u64::MAX, i128::MIN);
        let delegate = delegate_is(&Address([2; 32]), Some(&Address([3; 32])));

        assert_eq!(amount.data().len(), 32);
        assert_eq!(delegate.data().len(), 37);
        let mut overflowed = LighthouseInstruction::new(&[]);
        overflowed.bytes(&[0; MAX_DATA]).bytes(&[0]);

        assert!(overflowed.data().is_empty());
    }

    #[test]
    fn the_constant_is_lighthouse() {
        let lighthouse = solana_address::Address::from_str_const("L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95");

        assert_eq!(LIGHTHOUSE_PROGRAM.0, lighthouse.to_bytes());
    }
}
