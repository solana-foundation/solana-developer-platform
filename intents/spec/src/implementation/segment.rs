use super::payload::require_zero;
use super::wire::{Encoding, SegmentSourceKind, SegmentV1, MAX_ACCOUNT_BYTES};
use crate::{PodU16, PoolRefV1, SpecError, ValueRef};

/// One part of an instruction's data or of a PDA's seeds.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Segment {
    /// Bytes that the compiler encoded, read with `Implementation::text`.
    Literal(PoolRefV1),
    Reference {
        value: ValueRef,
        encoding: Encoding,
    },
    /// `length` bytes at `offset` in an account, which `owner` must own.
    AccountBytes {
        account: u8,
        owner: u8,
        offset: u16,
        length: u8,
    },
}

impl SegmentV1 {
    /// The encoding byte of a literal or account bytes segment is zero, because those bytes are
    /// already final.
    pub fn decode(&self) -> Result<Segment, SpecError> {
        let [a, b, c, d, e, f] = self.payload;
        let source = SegmentSourceKind::try_from(self.source)?;

        if source != SegmentSourceKind::Reference && self.encoding != 0 {
            return Err(SpecError::BadCode);
        }

        match source {
            SegmentSourceKind::Literal => {
                require_zero(&[e, f])?;

                Ok(Segment::Literal(PoolRefV1 { offset: PodU16([a, b]), len: PodU16([c, d]) }))
            }
            SegmentSourceKind::Reference => {
                require_zero(&[c, d, e, f])?;

                Ok(Segment::Reference {
                    value: ValueRef::from_bytes([a, b])?,
                    encoding: Encoding::try_from(self.encoding)?,
                })
            }
            SegmentSourceKind::AccountBytes => {
                require_zero(&[f])?;

                if e > MAX_ACCOUNT_BYTES {
                    return Err(SpecError::BadCode);
                }

                Ok(Segment::AccountBytes { account: a, owner: b, offset: u16::from_le_bytes([c, d]), length: e })
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ValueSource;

    fn segment(source: SegmentSourceKind, encoding: u8, payload: [u8; 6]) -> SegmentV1 {
        SegmentV1 { source: source.into(), encoding, payload }
    }

    #[test]
    fn decodes_a_literal_as_a_pool_range() {
        let wire = segment(SegmentSourceKind::Literal, 0, [1, 0, 4, 0, 0, 0]);

        assert_eq!(wire.decode(), Ok(Segment::Literal(PoolRefV1 { offset: PodU16::new(1), len: PodU16::new(4) })));
    }

    #[test]
    fn decodes_a_reference_with_its_encoding() {
        let wire = segment(SegmentSourceKind::Reference, Encoding::U64Le.into(), [1, 3, 0, 0, 0, 0]);

        assert_eq!(
            wire.decode(),
            Ok(Segment::Reference {
                value: ValueRef { source: ValueSource::Input, index: 3 },
                encoding: Encoding::U64Le
            })
        );
    }

    #[test]
    fn refuses_an_encoding_on_final_bytes_and_long_account_reads() {
        let literal = segment(SegmentSourceKind::Literal, Encoding::U8.into(), [0, 0, 1, 0, 0, 0]);
        let too_long = segment(SegmentSourceKind::AccountBytes, 0, [0, 0, 44, 0, 33, 0]);

        assert_eq!(literal.decode(), Err(SpecError::BadCode));
        assert_eq!(too_long.decode(), Err(SpecError::BadCode));
    }

    #[test]
    fn decoded_segment_fits_in_a_register_pair() {
        assert!(core::mem::size_of::<Segment>() <= 8);
    }
}
