//! The engine's [`Chain`] over the accounts of the instruction. An account that the instruction
//! does not pass is missing, so one `resolve` completes or fails.

use alloc::vec::Vec;

use anchor_lang::prelude::*;
use pinocchio::account::Ref;
use sdp_intents_engine::{AccountData, Chain};

/// The accounts after the fixed ones, with a shared borrow of the data of each. Nothing in
/// `verify_intent` writes an account, and a readonly CPI accepts a shared borrow.
pub struct PassedAccounts<'a> {
    pub views: &'a [AccountView],
    data: Vec<Ref<'a, [u8]>>,
}

impl<'a> PassedAccounts<'a> {
    pub fn borrow(views: &'a [AccountView]) -> Result<Self> {
        let data = views.iter().map(AccountView::try_borrow).collect::<core::result::Result<Vec<_>, _>>()?;

        Ok(Self { views, data })
    }

    pub fn view(&self, address: &sdp_intents_spec::Address) -> Option<&'a AccountView> {
        self.views.iter().find(|view| view.address().as_ref() == address.0)
    }
}

impl Chain for PassedAccounts<'_> {
    fn account(&self, address: &sdp_intents_spec::Address) -> Option<AccountData<'_>> {
        let position = self.views.iter().position(|view| view.address().as_ref() == address.0)?;
        let view = self.views.get(position)?;
        let data = self.data.get(position)?;

        Some(AccountData {
            owner: bytemuck::try_from_bytes(view.owner().as_ref()).ok()?,
            data,
            lamports: view.lamports(),
        })
    }
}
