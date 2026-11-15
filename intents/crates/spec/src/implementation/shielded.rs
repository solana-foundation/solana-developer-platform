//! A shielded recipe states what a spend does (`DESIGN.md`, 4.17): the notes that it creates, the
//! public amounts that it deposits, and the public amounts that it withdraws. Each is an instruction
//! of the pool, notes first, then deposits, then withdrawals. Spec 1.1 adds the protocol, the
//! counts, and the circuit, in the extension area.

use bytemuck::{Pod, Zeroable};

use super::flow::DocumentRefV1;
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
    pub deposits: u8,
    pub withdrawals: u8,
    /// The circuit document that the spender proves with, at its exact version.
    pub circuit: DocumentRefV1,
}

/// What each instruction of a shielded recipe states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ShieldedEntry {
    /// A note that the spend creates. Its account is the owner.
    Note,
    /// A public amount that the spend takes from its account into the pool.
    Deposit,
    /// A public amount that the spend pays from the pool to its account.
    Withdrawal,
}

impl Implementation<'_> {
    /// The protocol, the counts, and the circuit pin of a shielded recipe, or `None` for another
    /// recipe.
    pub fn shielded(&self) -> Result<Option<&ShieldedDocV1>, SpecError> {
        if self.recipe()? != RecipeKind::Shielded {
            return Ok(None);
        }

        crate::region::Region::new(self.extension()).fixed(0).map(Some)
    }

    pub fn shielded_protocol(&self) -> Result<Option<ShieldedProtocol>, SpecError> {
        self.shielded()?.map(|doc| ShieldedProtocol::try_from(doc.protocol)).transpose()
    }

    /// What the instruction at `index` states, or `None` past the last one.
    pub fn shielded_entry(&self, index: usize) -> Result<Option<ShieldedEntry>, SpecError> {
        let doc = self.shielded()?.ok_or(SpecError::BadRecipe)?;
        let count = self.instructions()?.len();
        let legs = usize::from(doc.deposits).checked_add(usize::from(doc.withdrawals)).ok_or(SpecError::BadRecipe)?;
        let notes = count.checked_sub(legs).ok_or(SpecError::BadRecipe)?;
        let deposits_end = notes.checked_add(usize::from(doc.deposits)).ok_or(SpecError::BadRecipe)?;

        Ok(match index {
            index if index >= count => None,
            index if index < notes => Some(ShieldedEntry::Note),
            index if index < deposits_end => Some(ShieldedEntry::Deposit),
            _ => Some(ShieldedEntry::Withdrawal),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout_is_pinned() {
        assert_eq!(core::mem::size_of::<ShieldedDocV1>(), 3 + 74);
    }
}
