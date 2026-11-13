use anchor_lang::prelude::*;

use crate::state::wire::PodBool;

/// The registry's own settings, at the PDA of `"config"`. While `organizations_gated` holds, only
/// `admin` creates organizations, so no one takes a name such as `solana` before its owner.
#[account]
pub struct RegistryConfigV1 {
    pub admin: Address,
    pub organizations_gated: PodBool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<RegistryConfigV1>(), 33);
    }
}
