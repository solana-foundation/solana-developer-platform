//! `GET /health` — liveness, plus the information needed to spot version skew.
//!
//! Liveness only, matching the repo's convention (`apps/sdp-api/src/routes/health.ts`):
//! a status below 500 means the HTTP layer is up. Dependency probing belongs on a
//! readiness path, and SDP's own `/health/ready` does not probe downstream
//! services. Adding the gateway there would make SDP's readiness depend on the
//! gateway's.
//!
//! The remaining fields report version skew. zolana crates are unpublished and
//! pinned by git rev, so a breaking on-chain layout change and a patch release
//! are indistinguishable from a version number. Reporting the pinned rev
//! alongside the live on-chain config makes skew observable in monitoring instead
//! of surfacing later as a decode failure on a real operation.

use serde::Serialize;

use super::common::{Base58Address, Base64Bytes};

/// Health response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    /// Always `"ok"` when the HTTP layer is serving.
    pub status: &'static str,
    /// This service's package version.
    pub version: &'static str,
    /// Git revision of the zolana dependency this binary was built against.
    pub zolana_rev: &'static str,
    /// Program ids compiled into this binary as expected values.
    pub expected_programs: ExpectedPrograms,
    /// The live protocol config read from chain at startup, or `None` if the
    /// preflight read failed.
    pub protocol_config: Option<ProtocolConfigSnapshot>,
}

/// Program ids this build expects to be talking to.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpectedPrograms {
    /// Shielded pool program.
    pub shielded_pool: Base58Address,
}

/// What the on-chain protocol config said at startup.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolConfigSnapshot {
    /// The config PDA that was read.
    pub address: Base58Address,
    /// Raw account bytes, base64. Left undecoded because a decoded view would be
    /// interpreted through this build's layout assumptions, which is what a skew
    /// check must not do.
    pub data: Base64Bytes,
    /// Account data length. The protocol config is 132 bytes; anything else means
    /// the layout moved under the pinned revision.
    pub data_len: u32,
    /// Slot the read was taken at.
    pub slot: u64,
    /// Whether permissionless ring creation is enabled.
    ///
    /// Expected to be `false` on devnet. Surfaced because it is the gate on
    /// policy-ring support: when it flips, zone flows become reachable.
    pub ring_creation_is_permissionless: bool,
    /// Whether permissionless SPL interface creation is enabled. Expected
    /// `true`, which is what makes the SPL asset allowlist work possible.
    pub spl_interface_creation_is_permissionless: bool,
}
