//! Bounds-checked reads of a document's bytes. Every read returns a reference into the bytes, and
//! fails with `SpecError` instead of panicking.

use bytemuck::Pod;

use crate::{PoolRefV1, SpecError, TableRefV1};

#[derive(Clone, Copy)]
pub(crate) struct Region<'a> {
    bytes: &'a [u8],
}

impl<'a> Region<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { bytes }
    }

    pub(crate) fn slice(self, offset: usize, len: usize) -> Result<&'a [u8], SpecError> {
        let end = offset.checked_add(len).ok_or(SpecError::OutOfBounds)?;

        self.bytes.get(offset..end).ok_or(SpecError::OutOfBounds)
    }

    pub(crate) fn fixed<T: Pod>(self, offset: usize) -> Result<&'a T, SpecError> {
        let bytes = self.slice(offset, core::mem::size_of::<T>()).map_err(|_| SpecError::Truncated)?;

        bytemuck::try_from_bytes(bytes).map_err(|_| SpecError::Truncated)
    }

    pub(crate) fn table<T: Pod>(self, table: TableRefV1) -> Result<&'a [T], SpecError> {
        let len = core::mem::size_of::<T>().checked_mul(usize::from(table.count)).ok_or(SpecError::OutOfBounds)?;
        let bytes = self.slice(usize::from(table.offset.get()), len)?;

        bytemuck::try_cast_slice(bytes).map_err(|_| SpecError::OutOfBounds)
    }

    pub(crate) fn pool(self, pool: PoolRefV1) -> Result<Pool<'a>, SpecError> {
        let bytes = self.slice(usize::from(pool.offset.get()), usize::from(pool.len.get()))?;

        Ok(Pool { bytes })
    }
}

/// The byte pool of one document. Entries name ranges of it with a `PoolRefV1`.
#[derive(Clone, Copy)]
pub(crate) struct Pool<'a> {
    bytes: &'a [u8],
}

impl<'a> Pool<'a> {
    pub(crate) fn get(self, range: PoolRefV1) -> Result<&'a [u8], SpecError> {
        Region::new(self.bytes).slice(usize::from(range.offset.get()), usize::from(range.len.get()))
    }
}

/// Reads consecutive structures from the front of some bytes, for the layouts that have no tables.
#[derive(Clone, Copy)]
pub(crate) struct Cursor<'a> {
    rest: &'a [u8],
}

impl<'a> Cursor<'a> {
    pub(crate) fn new(bytes: &'a [u8]) -> Self {
        Self { rest: bytes }
    }

    pub(crate) fn take(&mut self, len: usize) -> Result<&'a [u8], SpecError> {
        let (taken, rest) = self.rest.split_at_checked(len).ok_or(SpecError::Truncated)?;
        self.rest = rest;

        Ok(taken)
    }

    pub(crate) fn fixed<T: Pod>(&mut self) -> Result<&'a T, SpecError> {
        bytemuck::try_from_bytes(self.take(core::mem::size_of::<T>())?).map_err(|_| SpecError::Truncated)
    }

    pub(crate) fn entries<T: Pod>(&mut self, count: usize) -> Result<&'a [T], SpecError> {
        let len = core::mem::size_of::<T>().checked_mul(count).ok_or(SpecError::OutOfBounds)?;

        bytemuck::try_cast_slice(self.take(len)?).map_err(|_| SpecError::Truncated)
    }

    pub(crate) fn rest(self) -> &'a [u8] {
        self.rest
    }

    /// A layout ends where its last structure ends, so that one result has one encoding.
    pub(crate) fn finish(self) -> Result<(), SpecError> {
        if !self.rest.is_empty() {
            return Err(SpecError::LengthMismatch);
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::PodU16;

    #[test]
    fn table_reads_only_inside_the_bytes() {
        let region = Region::new(&[1, 2, 3, 4]);
        let table = TableRefV1 { offset: PodU16::new(1), count: 3 };

        assert_eq!(region.table::<u8>(table), Ok(&[2u8, 3, 4][..]));
        assert_eq!(region.table::<u8>(TableRefV1 { count: 4, ..table }), Err(SpecError::OutOfBounds));
    }

    #[test]
    fn pool_ranges_start_at_the_pool() {
        let region = Region::new(&[9, 9, 5, 6, 7]);
        let pool = region.pool(PoolRefV1 { offset: PodU16::new(2), len: PodU16::new(3) }).unwrap();

        assert_eq!(pool.get(PoolRefV1 { offset: PodU16::new(1), len: PodU16::new(2) }), Ok(&[6u8, 7][..]));
        assert!(pool.get(PoolRefV1 { offset: PodU16::new(2), len: PodU16::new(2) }).is_err());
    }
}
