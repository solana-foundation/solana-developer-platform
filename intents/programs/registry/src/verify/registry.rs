//! The registry part of `verify_intent`: the indexes name the documents, and the implementation
//! version is approved unless the intent allows an unapproved one.
//!
//! The engine's `bind` checks that the documents are the ones that the intent names. A version
//! account that the registry owns holds the document of the id in it, because `publish` creates
//! it only at the address of that id. So no address needs to be derived here.

use anchor_lang::prelude::*;
use sdp_intents_engine::Recipe;
use sdp_intents_spec::wire::{DocumentIdV1, DocumentKind};

use crate::error::RegistryError;
use crate::state::index::{self, Index};
use crate::state::spec_address;
use crate::verify::VerifyIntent;

pub fn check_indexes(accounts: &VerifyIntent, recipe: &Recipe<'_>) -> Result<()> {
    let interface_data = index::load(accounts.interface_index.account())?;
    let interface = Index::parse(&interface_data)?;
    let implementation_data = index::load(accounts.implementation_index.account())?;
    let implementation = Index::parse(&implementation_data)?;
    let implementation_id = recipe.implementation().id();

    require_names(&interface, DocumentKind::Interface, recipe.interface().id())?;
    require_names(&implementation, DocumentKind::Implementation, implementation_id)?;
    require!(implementation.header.interface == *accounts.interface_index.address(), RegistryError::WrongAccount);

    if recipe.intent().options().map_err(|_| RegistryError::RecipeRefused)?.allow_unapproved {
        return Ok(());
    }

    let version_approved = implementation.entry(&implementation_id.version).is_some_and(|entry| entry.approved.get());
    require!(
        version_approved && interface.approves(accounts.implementation_index.address()),
        RegistryError::NotApproved
    );

    Ok(())
}

fn require_names(index: &Index<'_>, kind: DocumentKind, id: &DocumentIdV1) -> Result<()> {
    index.require_kind(kind)?;
    require!(
        spec_address(&index.header.organization) == id.publisher && index.header.name_hash == id.name_hash,
        RegistryError::WrongAccount
    );

    Ok(())
}
