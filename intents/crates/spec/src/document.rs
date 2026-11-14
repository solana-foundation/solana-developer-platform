use bytemuck::{Pod, Zeroable};

use crate::code::wire_code;
use crate::{Address, PodU16, SpecError};

pub const MAGIC: [u8; 4] = *b"SDPI";
pub const SPEC_MAJOR: u8 = 1;
/// The latest minor version that a reader knows. 1 adds the flow recipe (`DESIGN.md`, 4.19).
pub const SPEC_MINOR: u8 = 1;

wire_code! {
    pub enum DocumentKind {
        Interface = 1,
        Implementation = 2,
        Intent = 3,
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct DocumentHeaderV1 {
    pub magic: [u8; 4],
    pub spec_major: u8,
    pub spec_minor: u8,
    pub kind: u8,
    pub body_len: PodU16,
    pub extension_len: PodU16,
}

impl DocumentHeaderV1 {
    pub const LEN: usize = core::mem::size_of::<Self>();

    /// Checks the header against the document that holds it. A reader refuses a later minor
    /// version, because an ignored field can be a loosened check.
    pub fn check(&self, kind: DocumentKind, document_len: usize) -> Result<(), SpecError> {
        if self.magic != MAGIC {
            return Err(SpecError::BadMagic);
        }

        if self.spec_major != SPEC_MAJOR || self.spec_minor > SPEC_MINOR {
            return Err(SpecError::UnsupportedVersion);
        }

        if DocumentKind::try_from(self.kind)? != kind {
            return Err(SpecError::WrongKind);
        }

        let declared_len = Self::LEN
            .checked_add(usize::from(self.body_len.get()))
            .and_then(|len| len.checked_add(usize::from(self.extension_len.get())))
            .ok_or(SpecError::LengthMismatch)?;

        if declared_len != document_len {
            return Err(SpecError::LengthMismatch);
        }

        Ok(())
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Pod, Zeroable)]
pub struct SemverV1 {
    pub major: PodU16,
    pub minor: PodU16,
    pub patch: PodU16,
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Pod, Zeroable)]
pub struct DocumentIdV1 {
    pub publisher: Address,
    /// SHA-256 of the name, such as `token.transfer`.
    pub name_hash: [u8; 32],
    pub version: SemverV1,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn header(kind: DocumentKind, body_len: u16) -> DocumentHeaderV1 {
        DocumentHeaderV1 {
            magic: MAGIC,
            spec_major: SPEC_MAJOR,
            spec_minor: SPEC_MINOR,
            kind: kind.into(),
            body_len: PodU16::new(body_len),
            extension_len: PodU16::new(0),
        }
    }

    #[test]
    fn layout_is_pinned() {
        assert_eq!(DocumentHeaderV1::LEN, 11);
        assert_eq!(core::mem::size_of::<DocumentIdV1>(), 70);
    }

    #[test]
    fn header_accepts_its_own_document() {
        let header = header(DocumentKind::Implementation, 100);

        assert_eq!(header.check(DocumentKind::Implementation, 111), Ok(()));
    }

    #[test]
    fn header_refuses_a_later_minor_version() {
        let header = DocumentHeaderV1 { spec_minor: 2, ..header(DocumentKind::Implementation, 0) };

        assert_eq!(header.check(DocumentKind::Implementation, 11), Err(SpecError::UnsupportedVersion));
    }

    #[test]
    fn header_refuses_another_kind_and_another_length() {
        let header = header(DocumentKind::Interface, 0);

        assert_eq!(header.check(DocumentKind::Implementation, 11), Err(SpecError::WrongKind));
        assert_eq!(header.check(DocumentKind::Interface, 12), Err(SpecError::LengthMismatch));
    }
}
