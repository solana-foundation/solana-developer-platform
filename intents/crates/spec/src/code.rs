//! Wire codes: a one-byte field that names a variant.

/// Defines a `#[repr(u8)]` enum and its conversion from a wire byte. An unknown byte is
/// `SpecError::BadCode`.
macro_rules! wire_code {
    ($(#[$meta:meta])* pub enum $name:ident { $($(#[$variant_meta:meta])* $variant:ident = $value:literal,)+ }) => {
        $(#[$meta])*
        #[repr(u8)]
        #[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
        pub enum $name {
            $($(#[$variant_meta])* $variant = $value,)+
        }

        impl TryFrom<u8> for $name {
            type Error = $crate::SpecError;

            fn try_from(code: u8) -> Result<Self, Self::Error> {
                match code {
                    $($value => Ok(Self::$variant),)+
                    _ => Err($crate::SpecError::BadCode),
                }
            }
        }

        impl From<$name> for u8 {
            fn from(code: $name) -> Self {
                code as u8
            }
        }
    };
}

pub(crate) use wire_code;
