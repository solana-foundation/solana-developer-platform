//! Alignment-1 integers. Wire structs hold these instead of native integers, so that a struct casts
//! in place at any offset. The layout matches the pod types of Anchor v2.

use bytemuck::{Pod, Zeroable};

macro_rules! pod_unsigned {
    ($name:ident, $native:ty, $size:literal) => {
        #[repr(transparent)]
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Pod, Zeroable)]
        pub struct $name(pub [u8; $size]);

        impl $name {
            pub const fn new(value: $native) -> Self {
                Self(value.to_le_bytes())
            }

            pub const fn get(self) -> $native {
                <$native>::from_le_bytes(self.0)
            }
        }

        impl From<$native> for $name {
            fn from(value: $native) -> Self {
                Self::new(value)
            }
        }
    };
}

pod_unsigned!(PodU16, u16, 2);
pod_unsigned!(PodU32, u32, 4);
pod_unsigned!(PodU64, u64, 8);

#[repr(transparent)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, Pod, Zeroable)]
pub struct PodBool(pub u8);

impl PodBool {
    pub const fn new(value: bool) -> Self {
        Self(value as u8)
    }

    pub const fn get(self) -> bool {
        self.0 != 0
    }
}

impl From<bool> for PodBool {
    fn from(value: bool) -> Self {
        Self::new(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn integers_round_trip_in_little_endian() {
        assert_eq!(PodU16::new(0x0102).0, [0x02, 0x01]);
        assert_eq!(PodU32::new(7).get(), 7);
        assert_eq!(PodU64::new(u64::MAX).get(), u64::MAX);
    }

    #[test]
    fn pod_types_have_alignment_one() {
        assert_eq!(core::mem::align_of::<PodU16>(), 1);
        assert_eq!(core::mem::align_of::<PodU32>(), 1);
        assert_eq!(core::mem::align_of::<PodU64>(), 1);
        assert_eq!(core::mem::align_of::<PodBool>(), 1);
    }
}
