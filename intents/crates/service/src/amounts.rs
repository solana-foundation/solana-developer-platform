//! Decimal token amounts in a request, rewritten in base units before the request compiles. The
//! service reads the mints in one call, and the planner's later read of them comes from the cache.

use sdp_intents_chain::{CachedRpc, Freshness};
use sdp_intents_compiler::{decimal_mints, mint_decimals, with_base_units, Catalog, MintAccount, MintDecimals};
use serde_json::Value;

use crate::ServiceError;

/// `request` with each `{ "decimal": … }` amount in the base units of its mint.
pub async fn in_base_units(chain: &CachedRpc, catalog: &Catalog, request: &Value) -> Result<Value, ServiceError> {
    let mints = decimal_mints(request, catalog);

    if mints.is_empty() {
        return Ok(request.clone());
    }

    let accounts = chain.accounts(&mints, Freshness::Live).await?;
    let decimals = mints
        .iter()
        .zip(&accounts)
        .map(|(mint, account)| {
            let account = account.as_ref().map(|account| MintAccount { owner: &account.owner, data: &account.data });

            mint_decimals(mint, account).map(|decimals| MintDecimals { mint: *mint, decimals }).ok_or_else(|| {
                ServiceError::refused(
                    "notAMint",
                    format!("{} is not a mint, so an amount of it has no decimals", bs58::encode(mint.0).into_string()),
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;

    with_base_units(request, catalog, &decimals).map_err(|report| ServiceError::compile(&report, &request.to_string()))
}
