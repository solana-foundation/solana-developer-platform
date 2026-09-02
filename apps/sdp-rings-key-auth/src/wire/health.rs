//! Health response types.

use serde::Serialize;

/// Liveness and adapter-readiness response.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HealthResponse {
    /// Always `ok` when the HTTP process is serving.
    pub status: &'static str,
    /// Crate version.
    pub version: &'static str,
    /// Whether all production capability adapters are installed.
    pub ready: bool,
    /// Per-capability readiness.
    pub adapters: AdapterReadinessResponse,
}

/// Availability of the production capability adapters.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdapterReadinessResponse {
    /// Stage-token verifier.
    pub stage_authorizer: bool,
    /// Encrypted key repository.
    pub key_store: bool,
    /// Envelope cipher.
    pub envelope_cipher: bool,
    /// Sidecar client.
    pub gateway_client: bool,
}
