//! Lays out a document: the fixed part, then each table in the order that the caller adds it, then
//! the pool.
//!
//! An offset or an index that does not fit its field is clamped. The limits in `limits` are below
//! every field's range, and the compiler checks them before it writes, so a clamped value never
//! reaches a document that the compiler returns.

use bytemuck::{bytes_of, cast_slice, Pod};

use sdp_intents_spec::{
    Address, DocumentHeaderV1, DocumentKind, PodU16, PoolRefV1, RangeV1, TableRefV1, MAGIC, SPEC_MAJOR, SPEC_MINOR,
};

#[derive(Debug, Default)]
pub struct Pool {
    bytes: Vec<u8>,
}

impl Pool {
    pub fn add(&mut self, bytes: &[u8]) -> PoolRefV1 {
        let range = PoolRefV1 { offset: clamp_u16(self.bytes.len()), len: clamp_u16(bytes.len()) };
        self.bytes.extend_from_slice(bytes);

        range
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }
}

/// The addresses table. An address that is already in the table keeps its index.
#[derive(Debug, Default)]
pub struct AddressTable {
    addresses: Vec<Address>,
}

impl AddressTable {
    pub fn index(&mut self, address: Address) -> u8 {
        let index = self.addresses.iter().position(|known| *known == address).unwrap_or_else(|| {
            self.addresses.push(address);
            self.addresses.len().saturating_sub(1)
        });

        u8::try_from(index).unwrap_or(u8::MAX)
    }

    /// Appends `addresses` as one run, even when some are already in the table, and returns the run.
    /// `invokesOnly` names its programs as a range, so its addresses must be consecutive.
    pub fn push_run(&mut self, addresses: &[Address]) -> RangeV1 {
        let first = u8::try_from(self.addresses.len()).unwrap_or(u8::MAX);
        self.addresses.extend_from_slice(addresses);

        RangeV1 { first, count: u8::try_from(addresses.len()).unwrap_or(u8::MAX) }
    }

    pub fn as_slice(&self) -> &[Address] {
        &self.addresses
    }
}

pub struct Writer {
    bytes: Vec<u8>,
    fixed_len: usize,
}

impl Writer {
    pub fn new<Fixed: Pod>() -> Self {
        let fixed_len = core::mem::size_of::<Fixed>();

        Self { bytes: vec![0; fixed_len], fixed_len }
    }

    pub fn table<T: Pod>(&mut self, entries: &[T]) -> TableRefV1 {
        let table =
            TableRefV1 { offset: clamp_u16(self.bytes.len()), count: u8::try_from(entries.len()).unwrap_or(u8::MAX) };
        self.bytes.extend_from_slice(cast_slice(entries));

        table
    }

    pub fn pool(&mut self, pool: &Pool) -> PoolRefV1 {
        let range = PoolRefV1 { offset: clamp_u16(self.bytes.len()), len: clamp_u16(pool.bytes.len()) };
        self.bytes.extend_from_slice(&pool.bytes);

        range
    }

    pub fn header(&self, kind: DocumentKind) -> DocumentHeaderV1 {
        DocumentHeaderV1 {
            magic: MAGIC,
            spec_major: SPEC_MAJOR,
            spec_minor: SPEC_MINOR,
            kind: kind.into(),
            body_len: clamp_u16(self.bytes.len().saturating_sub(DocumentHeaderV1::LEN)),
            extension_len: PodU16::new(0),
        }
    }

    /// Writes the fixed part over the zeros at the start, and returns the document.
    pub fn finish<Fixed: Pod>(mut self, fixed: &Fixed) -> Vec<u8> {
        if let Some(start) = self.bytes.get_mut(..self.fixed_len) {
            start.copy_from_slice(bytes_of(fixed));
        }

        self.bytes
    }
}

fn clamp_u16(value: usize) -> PodU16 {
    PodU16::new(u16::try_from(value).unwrap_or(u16::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_address_keeps_its_first_index() {
        let mut table = AddressTable::default();

        assert_eq!(table.index(Address([1; 32])), 0);
        assert_eq!(table.index(Address([2; 32])), 1);
        assert_eq!(table.index(Address([1; 32])), 0);
    }
}
