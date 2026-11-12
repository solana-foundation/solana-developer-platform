//! Encodings: their names, which value types each one can hold, and how a literal turns into bytes.

use sdp_intents_spec::{BaseType, Encoding, ValueType};

/// `hex` exists only in JSON: the compiler turns a hex literal into bytes, so it never reaches the
/// binary form.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodingName {
    Wire(Encoding),
    Hex,
}

pub const NAMES: [(&str, EncodingName); 15] = [
    ("u8", EncodingName::Wire(Encoding::U8)),
    ("u16le", EncodingName::Wire(Encoding::U16Le)),
    ("u32le", EncodingName::Wire(Encoding::U32Le)),
    ("u64le", EncodingName::Wire(Encoding::U64Le)),
    ("u128le", EncodingName::Wire(Encoding::U128Le)),
    ("i8", EncodingName::Wire(Encoding::I8)),
    ("i16le", EncodingName::Wire(Encoding::I16Le)),
    ("i32le", EncodingName::Wire(Encoding::I32Le)),
    ("i64le", EncodingName::Wire(Encoding::I64Le)),
    ("i128le", EncodingName::Wire(Encoding::I128Le)),
    ("bool", EncodingName::Wire(Encoding::Bool)),
    ("address", EncodingName::Wire(Encoding::Address)),
    ("utf8", EncodingName::Wire(Encoding::Utf8)),
    ("borsh", EncodingName::Wire(Encoding::Borsh)),
    ("hex", EncodingName::Hex),
];

pub fn parse(name: &str) -> Option<EncodingName> {
    NAMES.iter().find(|(known, _)| *known == name).map(|(_, encoding)| *encoding)
}

/// The type of the value that a reference names, as an encoding sees it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shape {
    pub value_type: ValueType,
    pub optional: bool,
}

/// Whether `encoding` holds every value of `shape`, so that no value is cut short. An optional or
/// array value needs `borsh`, which writes the tag and the length.
pub fn fits(encoding: Encoding, shape: Shape) -> bool {
    if encoding == Encoding::Borsh {
        return true;
    }

    if shape.optional || shape.value_type.array {
        return false;
    }

    match shape.value_type.base {
        BaseType::Bool => encoding == Encoding::Bool,
        BaseType::Address | BaseType::Mint => encoding == Encoding::Address,
        BaseType::String => encoding == Encoding::Utf8,
        BaseType::Bytes => false,
        integer => integer_width(integer)
            .zip(integer_encoding(encoding))
            .is_some_and(|(value, room)| value.signed == room.signed && room.bits >= value.bits),
    }
}

/// The bytes of a literal in `encoding`, or the reason that the text is not such a literal.
pub fn literal_bytes(encoding: EncodingName, text: &str) -> Result<Vec<u8>, String> {
    let encoding = match encoding {
        EncodingName::Hex => return hex(text),
        EncodingName::Wire(encoding) => encoding,
    };

    match encoding {
        Encoding::Borsh => Err("a literal cannot use `borsh`, because a literal has no value type".to_owned()),
        Encoding::Bool => match text {
            "true" => Ok(vec![1]),
            "false" => Ok(vec![0]),
            _ => Err(format!("`{text}` is not a `bool`. Write `true` or `false`.")),
        },
        Encoding::Address => address(text).map(|address| address.to_vec()),
        Encoding::Utf8 => Ok(text.as_bytes().to_vec()),
        integer => integer_literal(integer, text),
    }
}

pub fn address(text: &str) -> Result<[u8; 32], String> {
    let bytes = bs58::decode(text).into_vec().map_err(|_| format!("`{text}` is not base58"))?;

    bytes.try_into().map_err(|bytes: Vec<u8>| format!("`{text}` is {} bytes, and an address is 32", bytes.len()))
}

#[derive(Clone, Copy)]
struct IntegerWidth {
    bits: u32,
    signed: bool,
}

fn integer_width(base: BaseType) -> Option<IntegerWidth> {
    let (bits, signed) = match base {
        BaseType::U8 => (8, false),
        BaseType::U16 => (16, false),
        BaseType::U32 => (32, false),
        BaseType::U64 => (64, false),
        BaseType::U128 => (128, false),
        BaseType::I8 => (8, true),
        BaseType::I16 => (16, true),
        BaseType::I32 => (32, true),
        BaseType::I64 => (64, true),
        BaseType::I128 => (128, true),
        _ => return None,
    };

    Some(IntegerWidth { bits, signed })
}

fn integer_encoding(encoding: Encoding) -> Option<IntegerWidth> {
    let base = match encoding {
        Encoding::U8 => BaseType::U8,
        Encoding::U16Le => BaseType::U16,
        Encoding::U32Le => BaseType::U32,
        Encoding::U64Le => BaseType::U64,
        Encoding::U128Le => BaseType::U128,
        Encoding::I8 => BaseType::I8,
        Encoding::I16Le => BaseType::I16,
        Encoding::I32Le => BaseType::I32,
        Encoding::I64Le => BaseType::I64,
        Encoding::I128Le => BaseType::I128,
        _ => return None,
    };

    integer_width(base)
}

/// Parses decimal digits into the little-endian bytes of the encoding's width.
fn integer_literal(encoding: Encoding, text: &str) -> Result<Vec<u8>, String> {
    let width = integer_encoding(encoding).ok_or_else(|| format!("`{text}` does not fit this encoding"))?;
    let bytes = usize::try_from(width.bits / 8).map_err(|_| "the width does not fit".to_owned())?;
    let out_of_range =
        || format!("`{text}` does not fit in {} {} bits", if width.signed { "signed" } else { "unsigned" }, width.bits);

    let le = if width.signed {
        let value: i128 = text.parse().map_err(|_| format!("`{text}` is not a decimal integer"))?;
        let shift = 128u32.saturating_sub(width.bits);

        if value.checked_shl(shift).and_then(|shifted| shifted.checked_shr(shift)) != Some(value) {
            return Err(out_of_range());
        }

        value.to_le_bytes()
    } else {
        let value: u128 = text.parse().map_err(|_| format!("`{text}` is not a decimal integer"))?;

        if width.bits < 128 && value >> width.bits != 0 {
            return Err(out_of_range());
        }

        value.to_le_bytes()
    };

    le.get(..bytes).map(<[u8]>::to_vec).ok_or_else(out_of_range)
}

fn hex(text: &str) -> Result<Vec<u8>, String> {
    if !text.len().is_multiple_of(2) {
        return Err(format!("`{text}` has an odd number of hex digits"));
    }

    (0..text.len())
        .step_by(2)
        .map(|at| {
            let pair = text.get(at..at.saturating_add(2)).unwrap_or_default();

            u8::from_str_radix(pair, 16).map_err(|_| format!("`{pair}` is not a hex byte"))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shape(base: BaseType) -> Shape {
        Shape { value_type: ValueType { base, array: false }, optional: false }
    }

    #[test]
    fn an_encoding_must_hold_every_value() {
        assert!(fits(Encoding::U64Le, shape(BaseType::U64)));
        assert!(fits(Encoding::U128Le, shape(BaseType::U64)));
        assert!(!fits(Encoding::U32Le, shape(BaseType::U64)));
        assert!(!fits(Encoding::I64Le, shape(BaseType::U64)));
        assert!(fits(Encoding::Address, shape(BaseType::Mint)));
        assert!(!fits(Encoding::Utf8, Shape { optional: true, ..shape(BaseType::String) }));
        assert!(fits(Encoding::Borsh, Shape { optional: true, ..shape(BaseType::String) }));
    }

    #[test]
    fn literals_become_little_endian_bytes() {
        assert_eq!(literal_bytes(EncodingName::Hex, "02000000"), Ok(vec![2, 0, 0, 0]));
        assert_eq!(literal_bytes(EncodingName::Wire(Encoding::U16Le), "258"), Ok(vec![2, 1]));
        assert_eq!(literal_bytes(EncodingName::Wire(Encoding::I8), "-1"), Ok(vec![0xff]));
        assert!(literal_bytes(EncodingName::Wire(Encoding::U8), "256").unwrap_err().contains("does not fit"));
        assert!(literal_bytes(EncodingName::Wire(Encoding::Borsh), "1").is_err());
    }

    #[test]
    fn addresses_are_32_bytes_of_base58() {
        assert_eq!(address("11111111111111111111111111111111"), Ok([0; 32]));
        assert!(address("abc").unwrap_err().contains("32"));
    }
}
