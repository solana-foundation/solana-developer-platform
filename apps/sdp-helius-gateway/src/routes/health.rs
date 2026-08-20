//! `GET /health`.

use axum::Json;
use axum::extract::State;

use crate::state::AppState;
use crate::wire::health::{ExpectedPrograms, HealthResponse, ProtocolConfigSnapshot};

/// Git revision of the zolana dependency, stamped at build time.
///
/// Set by `build.rs` from the `rev` in `Cargo.toml`. Reported so that skew
/// between this binary and the chain is visible in monitoring rather than
/// discovered when an operation fails to decode.
const ZOLANA_REV: &str = env!("ZOLANA_REV");

/// Liveness, plus the fields needed to detect version skew.
///
/// Serves the snapshot captured at startup rather than re-reading the chain: a
/// liveness probe must not depend on RPC availability.
pub async fn handle(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok",
        version: env!("CARGO_PKG_VERSION"),
        zolana_rev: ZOLANA_REV,
        expected_programs: ExpectedPrograms {
            shielded_pool: state.config.shielded_pool_program_id.clone(),
        },
        protocol_config: state.protocol_config.as_ref().as_ref().map(clone_snapshot),
    })
}

fn clone_snapshot(snapshot: &ProtocolConfigSnapshot) -> ProtocolConfigSnapshot {
    ProtocolConfigSnapshot {
        address: snapshot.address.clone(),
        data: snapshot.data.clone(),
        data_len: snapshot.data_len,
        slot: snapshot.slot,
        ring_creation_is_permissionless: snapshot.ring_creation_is_permissionless,
        spl_interface_creation_is_permissionless: snapshot.spl_interface_creation_is_permissionless,
    }
}
