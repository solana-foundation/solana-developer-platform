//! Reads the value that a `ValueRef` names, as an address or as bytes in an encoding.

use sdp_intents_spec::wire::SegmentV1;
use sdp_intents_spec::{Address, BaseType, Encoding, Segment, ValueRef, ValueSource};

use crate::borsh::{integer_width, is_signed};
use crate::documents::Documents;
use crate::resolve::Addresses;
use crate::{Chain, EngineError};

const LENGTH_PREFIX: usize = 4;
const WIDEST_INTEGER: usize = 16;

/// The bytes of one data segment or seed. Most borrow from the documents or the chain. Only an
/// integer that an encoding widens is held in place.
#[derive(Clone, Copy, Debug)]
pub struct Bytes<'r>(Repr<'r>);

#[derive(Clone, Copy, Debug)]
enum Repr<'r> {
    Borrowed(&'r [u8]),
    Widened { bytes: [u8; WIDEST_INTEGER], len: usize },
}

impl<'r> Bytes<'r> {
    pub(crate) const EMPTY: Bytes<'static> = Bytes(Repr::Borrowed(&[]));

    pub fn as_slice(&self) -> &[u8] {
        match &self.0 {
            Repr::Borrowed(bytes) => bytes,
            Repr::Widened { bytes, len } => bytes.get(..*len).unwrap_or_default(),
        }
    }

    pub(crate) fn from_address(address: &'r Address) -> Self {
        Self::borrowed(&address.0)
    }

    pub(crate) fn borrowed(bytes: &'r [u8]) -> Self {
        Self(Repr::Borrowed(bytes))
    }
}

/// What a read needs: the documents, the addresses resolved so far, and the chain.
pub(crate) struct Context<'r, C> {
    pub(crate) documents: Documents<'r>,
    pub(crate) addresses: &'r Addresses,
    pub(crate) chain: &'r C,
}

impl<C> Clone for Context<'_, C> {
    fn clone(&self) -> Self {
        *self
    }
}

impl<C> Copy for Context<'_, C> {}

impl<'r, C: Chain> Context<'r, C> {
    pub(crate) fn address(&self, value: ValueRef) -> Result<&'r Address, EngineError> {
        let index = value.index;

        match value.source {
            ValueSource::Input => {
                let bytes = self.input(index, Encoding::Address)?.0;
                let Repr::Borrowed(bytes) = bytes else {
                    return Err(EngineError::BadEncoding);
                };

                bytemuck::try_from_bytes(bytes).map_err(|_| EngineError::BadInput { input: index })
            }
            ValueSource::Payer if index == 0 => Ok(self.documents.payers.fee),
            ValueSource::Payer if index == 1 => Ok(self.documents.payers.rent),
            ValueSource::Account => self.addresses.get(index).ok_or(EngineError::Unresolved { account: index }),
            ValueSource::Address => self.static_address(index),
            ValueSource::Output => self.output_address(index),
            _ => Err(EngineError::BadEncoding),
        }
    }

    pub(crate) fn static_address(&self, index: u8) -> Result<&'r Address, EngineError> {
        let addresses = self.documents.implementation.addresses()?;

        addresses.get(usize::from(index)).ok_or(EngineError::Spec(sdp_intents_spec::SpecError::BadIndex))
    }

    /// A static recipe binds each output to the address of an account.
    pub(crate) fn output_address(&self, output: u8) -> Result<&'r Address, EngineError> {
        let binding = self.documents.implementation.output_bindings()?.iter().find(|binding| binding.output == output);
        let account = binding.ok_or(EngineError::UnboundOutput { output })?.account;

        self.addresses.get(account).ok_or(EngineError::Unresolved { account })
    }

    pub(crate) fn segment(&self, segment: &SegmentV1) -> Result<Bytes<'r>, EngineError> {
        match segment.decode()? {
            Segment::Literal(range) => Ok(Bytes::borrowed(self.documents.implementation.text(range)?)),
            Segment::Reference { value, encoding } => self.encoded(value, encoding),
            Segment::AccountBytes { account, owner, offset, length } => {
                let data = self.account_data(account, owner)?;
                let start = usize::from(offset);
                let end = start.checked_add(usize::from(length)).ok_or(EngineError::ShortData { account })?;

                data.get(start..end).map(Bytes::borrowed).ok_or(EngineError::ShortData { account })
            }
        }
    }

    /// The data of an account that the implementation reads, once the owner is the program it names.
    pub(crate) fn account_data(&self, account: u8, owner: u8) -> Result<&'r [u8], EngineError> {
        let address = self.addresses.get(account).ok_or(EngineError::Unresolved { account })?;
        let found = self.chain.account(address).ok_or(EngineError::MissingData { account })?;

        if found.owner != self.static_address(owner)? {
            return Err(EngineError::WrongOwner { account });
        }

        Ok(found.data)
    }

    fn encoded(&self, value: ValueRef, encoding: Encoding) -> Result<Bytes<'r>, EngineError> {
        match value.source {
            ValueSource::Input => self.input(value.index, encoding),
            ValueSource::Payer | ValueSource::Account | ValueSource::Address | ValueSource::Output => {
                if !matches!(encoding, Encoding::Address | Encoding::Borsh) {
                    return Err(EngineError::BadEncoding);
                }

                self.address(value).map(|address| Bytes::borrowed(&address.0))
            }
            ValueSource::Bumps if encoding == Encoding::Borsh => Ok(Bytes::borrowed(self.addresses.builder_bumps())),
            ValueSource::None | ValueSource::Literal | ValueSource::Bumps => Err(EngineError::BadEncoding),
        }
    }

    /// The intent holds each input in borsh, so `borsh` is the bytes as they are. Every other
    /// encoding reads a value that is neither optional nor an array.
    fn input(&self, index: u8, encoding: Encoding) -> Result<Bytes<'r>, EngineError> {
        let input =
            self.documents.interface.inputs()?.get(usize::from(index)).ok_or(EngineError::BadInput { input: index })?;
        let value_type = input.value_type()?;
        let bytes = self.documents.intent.input(index)?;

        if encoding == Encoding::Borsh {
            return Ok(Bytes::borrowed(bytes));
        }

        if input.optional() || value_type.array {
            return Err(EngineError::BadEncoding);
        }

        match (value_type.base, encoding) {
            (BaseType::Bool, Encoding::Bool) | (BaseType::Address | BaseType::Mint, Encoding::Address) => {
                Ok(Bytes::borrowed(bytes))
            }
            (BaseType::String, Encoding::Utf8) => {
                bytes.get(LENGTH_PREFIX..).map(Bytes::borrowed).ok_or(EngineError::BadInput { input: index })
            }
            (base, encoding) => widen(base, encoding, bytes),
        }
    }
}

/// Writes an integer at the width of its encoding. A signed value extends its sign.
fn widen<'r>(base: BaseType, encoding: Encoding, value: &[u8]) -> Result<Bytes<'r>, EngineError> {
    let from = integer_width(base).ok_or(EngineError::BadEncoding)?;
    let to = encoding_width(encoding).ok_or(EngineError::BadEncoding)?;
    let signed = is_signed_encoding(encoding);

    if signed != is_signed(base) || to < from || value.len() != from {
        return Err(EngineError::BadEncoding);
    }

    let negative = signed && value.last().is_some_and(|top| top & 0x80 != 0);
    let mut bytes = [if negative { 0xff } else { 0 }; WIDEST_INTEGER];
    bytes.get_mut(..from).ok_or(EngineError::BadEncoding)?.copy_from_slice(value);

    Ok(Bytes(Repr::Widened { bytes, len: to }))
}

fn encoding_width(encoding: Encoding) -> Option<usize> {
    match encoding {
        Encoding::U8 | Encoding::I8 => Some(1),
        Encoding::U16Le | Encoding::I16Le => Some(2),
        Encoding::U32Le | Encoding::I32Le => Some(4),
        Encoding::U64Le | Encoding::I64Le => Some(8),
        Encoding::U128Le | Encoding::I128Le => Some(16),
        _ => None,
    }
}

fn is_signed_encoding(encoding: Encoding) -> bool {
    matches!(encoding, Encoding::I8 | Encoding::I16Le | Encoding::I32Le | Encoding::I64Le | Encoding::I128Le)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn widens_an_integer_and_extends_its_sign() {
        let widened = widen(BaseType::U32, Encoding::U64Le, &[1, 0, 0, 0]).unwrap();
        assert_eq!(widened.as_slice(), [1, 0, 0, 0, 0, 0, 0, 0]);

        let negative = widen(BaseType::I8, Encoding::I32Le, &[0xfe]).unwrap();
        assert_eq!(negative.as_slice(), [0xfe, 0xff, 0xff, 0xff]);

        assert_eq!(widen(BaseType::U64, Encoding::U32Le, &[0; 8]).err(), Some(EngineError::BadEncoding));
        assert_eq!(widen(BaseType::U8, Encoding::I16Le, &[0]).err(), Some(EngineError::BadEncoding));
    }

    #[test]
    fn a_widened_value_stays_small() {
        assert!(core::mem::size_of::<Bytes>() <= 32);
    }
}
