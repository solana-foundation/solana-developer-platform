//! A shielded recipe names its protocol (`DESIGN.md`, 4.17), because only the protocol says how its
//! spender's client builds a spend and how a signer checks its notes. Spec 1.1 adds it, in the
//! extension area.

use bytemuck::{Pod, Zeroable};

use super::view::Implementation;
use super::wire::RecipeKind;
use crate::code::wire_code;
use crate::SpecError;

wire_code! {
    pub enum ShieldedProtocol {
        /// Solana Privacy Rings, by Helius.
        PrivacyRings = 1,
    }
}

#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Pod, Zeroable)]
pub struct ShieldedDocV1 {
    pub protocol: u8,
}

impl Implementation<'_> {
    /// The protocol of a shielded recipe, or `None` for another recipe.
    pub fn shielded_protocol(&self) -> Result<Option<ShieldedProtocol>, SpecError> {
        if self.recipe()? != RecipeKind::Shielded {
            return Ok(None);
        }

        let fixed: &ShieldedDocV1 = crate::region::Region::new(self.extension()).fixed(0)?;

        ShieldedProtocol::try_from(fixed.protocol).map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<ShieldedDocV1>(), 1);
    }
}
