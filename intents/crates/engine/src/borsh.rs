//! Checks that bytes hold one borsh value of a value type. `Recipe::bind` checks every input once,
//! so a later read of an input never reaches past it.

use sdp_intents_spec::{BaseType, ValueType};

const LENGTH_PREFIX: usize = 4;

/// Whether `bytes` are exactly one value of `value_type`. An optional value starts with its tag.
pub(crate) fn is_value(value_type: ValueType, optional: bool, bytes: &[u8]) -> bool {
    let value = match (optional, bytes.split_first()) {
        (false, _) => bytes,
        (true, Some((0, rest))) => return rest.is_empty(),
        (true, Some((1, rest))) => rest,
        (true, _) => return false,
    };

    value_len(value_type, value) == Some(value.len())
}

/// The width of an integer type, or `None` for another type.
pub(crate) fn integer_width(base: BaseType) -> Option<usize> {
    match base {
        BaseType::U8 | BaseType::I8 => Some(1),
        BaseType::U16 | BaseType::I16 => Some(2),
        BaseType::U32 | BaseType::I32 => Some(4),
        BaseType::U64 | BaseType::I64 => Some(8),
        BaseType::U128 | BaseType::I128 => Some(16),
        _ => None,
    }
}

pub(crate) fn is_signed(base: BaseType) -> bool {
    matches!(base, BaseType::I8 | BaseType::I16 | BaseType::I32 | BaseType::I64 | BaseType::I128)
}

pub(crate) fn value_len(value_type: ValueType, bytes: &[u8]) -> Option<usize> {
    if !value_type.array {
        return base_len(value_type.base, bytes);
    }

    let count = length(bytes)?;
    let mut rest = bytes.get(LENGTH_PREFIX..)?;
    let mut consumed = LENGTH_PREFIX;

    // Each element takes at least one byte, so the loop ends when the bytes do.
    for _ in 0..count {
        let len = base_len(value_type.base, rest)?;
        rest = rest.get(len..)?;
        consumed = consumed.checked_add(len)?;
    }

    Some(consumed)
}

fn base_len(base: BaseType, bytes: &[u8]) -> Option<usize> {
    let fixed = match base {
        BaseType::Bool => return matches!(bytes.first(), Some(0 | 1)).then_some(1),
        BaseType::Address | BaseType::Mint => 32,
        BaseType::String => {
            let text = bytes.get(LENGTH_PREFIX..)?.get(..length(bytes)?)?;
            core::str::from_utf8(text).ok()?;

            return LENGTH_PREFIX.checked_add(text.len());
        }
        BaseType::Bytes => return LENGTH_PREFIX.checked_add(length(bytes)?),
        integer => integer_width(integer)?,
    };

    (bytes.len() >= fixed).then_some(fixed)
}

fn length(bytes: &[u8]) -> Option<usize> {
    let [a, b, c, d] = *bytes.first_chunk::<LENGTH_PREFIX>()?;

    usize::try_from(u32::from_le_bytes([a, b, c, d])).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn of(base: BaseType) -> ValueType {
        ValueType { base, array: false }
    }

    #[test]
    fn accepts_exactly_one_value() {
        assert!(is_value(of(BaseType::U64), false, &[0; 8]));
        assert!(!is_value(of(BaseType::U64), false, &[0; 9]));
        assert!(is_value(of(BaseType::String), true, &[0]));
        assert!(is_value(of(BaseType::String), true, &[1, 2, 0, 0, 0, b'h', b'i']));
        assert!(!is_value(of(BaseType::String), true, &[1, 2, 0, 0, 0, 0xff, 0xfe]));
        assert!(!is_value(of(BaseType::Bool), false, &[2]));
        assert!(is_value(ValueType { base: BaseType::U16, array: true }, false, &[2, 0, 0, 0, 1, 0, 2, 0]));
        assert!(!is_value(ValueType { base: BaseType::U16, array: true }, false, &[9, 0, 0, 0, 1, 0]));
    }
}
