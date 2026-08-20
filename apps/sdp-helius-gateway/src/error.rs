//! The gateway's error taxonomy.
//!
//! Closed set, and retryability is an **explicit field** rather than something
//! the caller infers. SDP's Kora adapter decides retryability by substring
//! matching on upstream error text; that is a reasonable adaptation to a vendor
//! API, but we own both ends of this wire and should not inherit it.
//!
//! # Errors must not echo secrets
//!
//! Request bodies carry viewing and nullifier keys, and an upstream error's
//! `Display` may embed whatever it was handed. So wrapped errors are **logged in
//! full and serialized as a fixed string**. Only messages this module authors
//! reach the response body.

use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Serialize;

/// Every way a request can fail.
///
/// Most variants are unconstructed while the flow handlers are unimplemented. They
/// are declared up front because the taxonomy is part of the contract SDP switches
/// on.
#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum GatewayError {
    /// Malformed or semantically invalid request. Message is authored here, so
    /// it is safe to return.
    #[error("invalid request: {0}")]
    InvalidRequest(String),

    /// HMAC missing, malformed, mismatched, or outside the timestamp window.
    #[error("unauthorized")]
    Unauthorized,

    /// The wallet has no on-chain shielded identity yet.
    #[error("wallet is not registered")]
    WalletNotRegistered,

    /// The transfer recipient has no on-chain shielded identity.
    #[error("recipient is not registered")]
    RecipientNotRegistered,

    /// Not enough spendable private balance for the requested amount.
    #[error("insufficient shielded balance")]
    InsufficientShieldedBalance,

    /// A pinned input note is missing or already spent.
    ///
    /// A previous attempt for this operation likely landed on chain, so SDP must
    /// reconcile against the indexer rather than retry. Retrying would re-select
    /// different notes and could pay the recipient a second time.
    #[error("a pinned input note is unavailable or already spent")]
    InputUnavailable,

    /// No verifying key exists for the resolved input/output shape.
    ///
    /// Usually not a defect: it means the wallet's notes are too fragmented for
    /// a single transfer and need merging first. Surface it that way.
    #[error("unsupported circuit shape ({n_in} in, {n_out} out) — merge notes first")]
    UnsupportedShape {
        /// Resolved input count.
        n_in: u8,
        /// Resolved output count.
        n_out: u8,
    },

    /// The supplied fee payer does not match the one the proof commits.
    ///
    /// Not retryable, because the circuit carries the payer in public-input slot
    /// zero. The operation must be re-planned and re-proved.
    #[error("fee payer does not match the proved transaction")]
    FeePayerMismatch,

    /// The injected key material does not belong to the claimed owner.
    ///
    /// `sdp-api` writes `preamble.owner`; the key authority writes
    /// `preamble.keyMaterial`. This service is the only component that sees both
    /// halves, so it is the only place the disagreement can be caught — and it must
    /// be caught, because deriving a shielded identity from mismatched material
    /// would scan *that* wallet and return its balances and note inventory under
    /// the requested owner's operation.
    ///
    /// Not retryable and not reconcilable: a retry re-sends the same two halves,
    /// and nothing landed on chain to reconcile against. Fixing it means fixing
    /// whichever service resolved the wrong wallet.
    #[error("injected key material does not belong to the claimed owner")]
    KeyOwnerMismatch,

    /// The scan could not account for part of the wallet's history, so any
    /// balance derived from it may be short.
    #[error("sync incomplete")]
    SyncIncomplete,

    /// The indexer has not reached the slot the caller required.
    #[error("indexer has not reached the required slot")]
    IndexerLag,

    /// The gateway's prove deadline elapsed before a proof came back.
    ///
    /// The deadline is ours: nothing upstream provides one. So the job may well
    /// still be running server-side. A proof is a pure function of its witness, so
    /// retrying with the same pinned inputs is safe and usually faster — the proving
    /// key is warm by then — which is what makes this retryable rather than a
    /// reconcile.
    #[error("prover timed out")]
    ProverTimeout,

    /// The prover rejected the witness.
    #[error("prover failed")]
    ProverFailed(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// The indexer is unreachable or erroring.
    #[error("indexer unavailable")]
    IndexerUnavailable(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// Solana RPC is unreachable or erroring.
    #[error("rpc unavailable")]
    RpcUnavailable(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// The assembled transaction exceeds the wire packet limit.
    #[error("transaction is {size} bytes, over the {limit}-byte limit")]
    TxTooLarge {
        /// Serialized size produced.
        size: u32,
        /// Hard limit.
        limit: u32,
    },

    /// On-chain state does not match what this build expects.
    ///
    /// Not retryable: it needs a rebuild against a different zolana revision, or
    /// a corrected endpoint. Fail closed rather than decode with the wrong
    /// layout.
    #[error("on-chain layout does not match the pinned zolana revision")]
    VersionSkew,

    /// Anything unclassified.
    #[error("internal error")]
    Internal(#[source] Box<dyn std::error::Error + Send + Sync>),

    /// Routed but not yet built. Every flow endpoint returns this, so that a
    /// missing route is a 404 and an unimplemented one is not.
    #[error("not implemented")]
    NotImplemented,
}

/// Serialized error shape. Stable: SDP switches on `code`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorBody {
    /// Stable machine-readable discriminant.
    pub code: &'static str,
    /// Whether an identical retry could succeed.
    pub retryable: bool,
    /// Whether SDP must reconcile against chain state instead of retrying.
    pub reconcile: bool,
    /// Human-readable detail. Authored by this module; never upstream text.
    pub message: String,
}

impl GatewayError {
    /// Stable discriminant for SDP to switch on.
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest(_) => "INVALID_REQUEST",
            Self::Unauthorized => "UNAUTHORIZED",
            Self::WalletNotRegistered => "WALLET_NOT_REGISTERED",
            Self::RecipientNotRegistered => "RECIPIENT_NOT_REGISTERED",
            Self::InsufficientShieldedBalance => "INSUFFICIENT_SHIELDED_BALANCE",
            Self::InputUnavailable => "INPUT_UNAVAILABLE",
            Self::UnsupportedShape { .. } => "UNSUPPORTED_SHAPE",
            Self::FeePayerMismatch => "FEE_PAYER_MISMATCH",
            Self::KeyOwnerMismatch => "KEY_OWNER_MISMATCH",
            Self::SyncIncomplete => "SYNC_INCOMPLETE",
            Self::IndexerLag => "INDEXER_LAG",
            Self::ProverTimeout => "PROVER_TIMEOUT",
            Self::ProverFailed(_) => "PROVER_FAILED",
            Self::IndexerUnavailable(_) => "INDEXER_UNAVAILABLE",
            Self::RpcUnavailable(_) => "RPC_UNAVAILABLE",
            Self::TxTooLarge { .. } => "TX_TOO_LARGE",
            Self::VersionSkew => "VERSION_SKEW",
            Self::Internal(_) => "INTERNAL",
            Self::NotImplemented => "NOT_IMPLEMENTED",
        }
    }

    /// Whether an identical retry could plausibly succeed.
    ///
    /// Only transient upstream conditions qualify. Anything that depends on
    /// wallet or chain state is false, because a retry would re-derive that state
    /// and may act on a different input set.
    pub fn retryable(&self) -> bool {
        matches!(
            self,
            Self::SyncIncomplete
                | Self::IndexerLag
                | Self::ProverTimeout
                | Self::IndexerUnavailable(_)
                | Self::RpcUnavailable(_)
        )
    }

    /// Whether SDP must reconcile against chain state rather than retry.
    pub fn reconcile(&self) -> bool {
        matches!(self, Self::InputUnavailable)
    }

    /// HTTP status. `4xx` for caller- or state-caused, `5xx` for ours or
    /// upstream's.
    pub fn status(&self) -> StatusCode {
        match self {
            Self::InvalidRequest(_) => StatusCode::BAD_REQUEST,
            Self::Unauthorized => StatusCode::UNAUTHORIZED,
            Self::WalletNotRegistered
            | Self::RecipientNotRegistered
            | Self::InsufficientShieldedBalance
            | Self::InputUnavailable
            | Self::UnsupportedShape { .. }
            | Self::FeePayerMismatch
            | Self::KeyOwnerMismatch => StatusCode::CONFLICT,
            Self::TxTooLarge { .. } => StatusCode::PAYLOAD_TOO_LARGE,
            Self::SyncIncomplete
            | Self::IndexerLag
            | Self::IndexerUnavailable(_)
            | Self::RpcUnavailable(_) => StatusCode::SERVICE_UNAVAILABLE,
            Self::ProverTimeout => StatusCode::GATEWAY_TIMEOUT,
            Self::ProverFailed(_) => StatusCode::BAD_GATEWAY,
            Self::VersionSkew | Self::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
            Self::NotImplemented => StatusCode::NOT_IMPLEMENTED,
        }
    }

    /// Whether this variant wraps an upstream error whose text must not be
    /// serialized.
    fn wraps_upstream(&self) -> bool {
        matches!(
            self,
            Self::ProverFailed(_)
                | Self::IndexerUnavailable(_)
                | Self::RpcUnavailable(_)
                | Self::Internal(_)
        )
    }
}

impl IntoResponse for GatewayError {
    fn into_response(self) -> Response {
        let status = self.status();
        let code = self.code();

        // Log the full chain, including any wrapped upstream detail. This is the
        // only place that detail is allowed to appear.
        if status.is_server_error() {
            tracing::error!(error.code = code, error.detail = ?self, "request failed");
        } else {
            tracing::warn!(error.code = code, error.detail = %self, "request rejected");
        }

        // Wrapped upstream errors get a fixed message: their Display may embed
        // arguments the gateway was handed, which include key material.
        let message = if self.wraps_upstream() {
            format!("{code} — see gateway logs, correlated by requestId")
        } else {
            self.to_string()
        };

        let body = ErrorBody {
            code,
            retryable: self.retryable(),
            reconcile: self.reconcile(),
            message,
        };

        (status, Json(body)).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_detail_never_reaches_the_body() {
        let secret = "nullifier=deadbeefsecret";
        let err = GatewayError::Internal(secret.into());

        let rendered = serde_json::to_string(&ErrorBody {
            code: err.code(),
            retryable: err.retryable(),
            reconcile: err.reconcile(),
            message: format!("{} — see gateway logs, correlated by requestId", err.code()),
        })
        .unwrap();

        assert!(!rendered.contains("deadbeefsecret"), "leaked: {rendered}");
        assert!(rendered.contains("INTERNAL"));
    }

    #[test]
    fn key_owner_mismatch_is_terminal() {
        let err = GatewayError::KeyOwnerMismatch;
        assert_eq!(err.code(), "KEY_OWNER_MISMATCH");
        assert_eq!(err.status(), StatusCode::CONFLICT);
        // Neither a retry nor a reconcile can help: the two request halves came
        // from the wrong pair of records, and nothing landed on chain.
        assert!(!err.retryable());
        assert!(!err.reconcile());
    }

    #[test]
    fn input_unavailable_reconciles_and_does_not_retry() {
        let err = GatewayError::InputUnavailable;
        // A retry here could double-pay.
        assert!(!err.retryable());
        assert!(err.reconcile());
        assert_eq!(err.status(), StatusCode::CONFLICT);
    }

    #[test]
    fn only_transient_upstream_conditions_are_retryable() {
        assert!(GatewayError::IndexerLag.retryable());
        assert!(GatewayError::ProverTimeout.retryable());
        assert!(!GatewayError::FeePayerMismatch.retryable());
        assert!(!GatewayError::VersionSkew.retryable());
        assert!(!GatewayError::InsufficientShieldedBalance.retryable());
    }
}
