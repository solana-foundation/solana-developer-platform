use crate::code::wire_code;
use crate::SpecError;

wire_code! {
    pub enum BaseType {
        U8 = 1,
        U16 = 2,
        U32 = 3,
        U64 = 4,
        U128 = 5,
        I8 = 6,
        I16 = 7,
        I32 = 8,
        I64 = 9,
        I128 = 10,
        Bool = 11,
        Address = 12,
        Mint = 13,
        String = 14,
        Bytes = 15,
    }
}

const ARRAY_FLAG: u8 = 0x80;

/// The type of an input, an output, or a literal. Version 1 has scalar types and arrays of them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct ValueType {
    pub base: BaseType,
    pub array: bool,
}

impl TryFrom<u8> for ValueType {
    type Error = SpecError;

    fn try_from(code: u8) -> Result<Self, Self::Error> {
        Ok(Self { base: BaseType::try_from(code & !ARRAY_FLAG)?, array: code & ARRAY_FLAG != 0 })
    }
}

impl From<ValueType> for u8 {
    fn from(value_type: ValueType) -> Self {
        let base = u8::from(value_type.base);

        if value_type.array {
            base | ARRAY_FLAG
        } else {
            base
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arrays_set_the_high_bit() {
        let array = ValueType { base: BaseType::U64, array: true };

        assert_eq!(u8::from(array), 0x84);
        assert_eq!(ValueType::try_from(0x84), Ok(array));
        assert_eq!(ValueType::try_from(0x90), Err(SpecError::BadCode));
    }
}
