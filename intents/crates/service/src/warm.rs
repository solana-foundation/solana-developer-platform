//! Reads at start the accounts that most plans read, so that a plan fetches only its own accounts.
//! The service follows the registry's organizations and indexes, and the programs and the fixed
//! accounts that the implementations name. It pins each version account, which never changes while it
//! exists. The clock is not followed, because a cluster need not notify each change of a sysvar,
//! and a stale clock fails a program that checks time. Each plan's first fetch reads it.

use sdp_intents_chain::{CachedRpc, Freshness};
use sdp_intents_lighthouse::LIGHTHOUSE_PROGRAM;
use sdp_intents_registry_client::{IndexView, INDEX_DISCRIMINATOR, ORGANIZATION_DISCRIMINATOR, REGISTRY_PROGRAM};
use sdp_intents_spec::wire::DocumentKind;
use sdp_intents_spec::{Address, Implementation};

use crate::error::ServiceError;
use crate::registry::VersionChoice;

/// What the service read at start.
pub struct Warmed {
    pub followed: usize,
    pub pinned: usize,
}

pub async fn warm(chain: &CachedRpc) -> Result<Warmed, ServiceError> {
    let organizations = chain.program_accounts(&REGISTRY_PROGRAM, &ORGANIZATION_DISCRIMINATOR).await?;
    let indexes = chain.program_accounts(&REGISTRY_PROGRAM, &INDEX_DISCRIMINATOR).await?;

    let versions = indexes
        .iter()
        .filter_map(|index| IndexView::parse(&index.account.data).ok())
        .flat_map(|view| {
            let published = view.versions().filter(|entry| !entry.removed).collect::<Vec<_>>();

            published.into_iter().map(move |entry| VersionChoice::of(&view, &entry)).collect::<Vec<_>>()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let version_addresses = versions.iter().map(VersionChoice::address).collect::<Result<Vec<_>, _>>()?;
    chain.pin(&version_addresses).await?;

    let accounts = chain.accounts(&version_addresses, Freshness::Published).await?;
    let implementations = versions
        .iter()
        .zip(accounts)
        .filter(|(choice, _)| choice.kind == DocumentKind::Implementation)
        .filter_map(|(choice, account)| choice.document(account).ok())
        .collect::<Vec<_>>();
    let fixed = implementations
        .iter()
        .filter_map(|bytes| Implementation::parse(bytes).ok()?.addresses().ok().map(<[_]>::to_vec));

    let mut followed: Vec<Address> = organizations
        .iter()
        .chain(&indexes)
        .map(|listed| listed.address)
        .chain(fixed.flatten())
        .chain([LIGHTHOUSE_PROGRAM, REGISTRY_PROGRAM])
        .collect();
    followed.sort_unstable_by_key(|address| address.0);
    followed.dedup();
    chain.follow(&followed).await?;

    Ok(Warmed { followed: followed.len(), pinned: version_addresses.len() })
}
