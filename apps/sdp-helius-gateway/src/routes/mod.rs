//! Router assembly.
//!
//! Every endpoint is routed; only `/health` is implemented. The eight flow
//! endpoints return `501 NOT_IMPLEMENTED` rather than being absent, so a `404` in
//! a test unambiguously means a routing mistake instead of unfinished work.
//!
//! # The route table is also the caller table
//!
//! Routes are grouped by which caller may sign them, not only by path:
//!
//! | Caller | Routes |
//! | --- | --- |
//! | `sdp-api` | `register`, `merging`, `shield`, `assemble`, `nullifiers/status` |
//! | `rings-key-auth` | `sync`, `plan`, `prove` |
//! | unauthenticated | `health` |
//!
//! The split is load bearing: the key-bearing routes are the ones that receive
//! decrypted key material, and they are accepted only from the service that holds it.
//! See [`crate::auth`].

use std::time::Duration;

use axum::Router;
use axum::http::StatusCode;
use axum::routing::{get, post};
use tower_http::limit::RequestBodyLimitLayer;
use tower_http::timeout::TimeoutLayer;
use tower_http::trace::TraceLayer;

use crate::auth;
use crate::config::MAX_BODY_BYTES;
use crate::state::AppState;

pub mod assemble;
pub mod health;
pub mod merging;
pub mod nullifiers;
pub mod plan;
pub mod prove;
pub mod register;
pub mod shield;
pub mod sync;

/// Backstop for `/v1/operations/prove`. Nothing upstream bounds a prove call, so
/// the 600-second budget this sits above is one the gateway chooses, not one it
/// inherits.
///
/// The SDK's `PROVE_REQUEST_TIMEOUT_SECS = 600` is easy to mistake for a ceiling.
/// It is a timeout on one HTTP *request*: the submit is retried three times with a
/// two-second backoff, and transfer and merge proofs are queued, so the SDK then
/// polls a job under `AsyncPollConfig::max_wait_secs` (default 1200). That poll
/// ceiling counts only the time it spends *sleeping* between polls, never the time
/// spent in the status request itself — 1200/3 is 400 polls, each of which can take
/// up to 600 seconds on its own.
///
/// So the prove handler must impose `tokio::time::timeout` around its own work.
/// That is the only wall-clock bound in the system and the only one that can answer
/// with a structured `PROVER_TIMEOUT`. This constant is the outer backstop for a
/// handler that hangs outside its own timeout.
///
/// The Cloud Run service must be configured with `--timeout=700` so that this layer
/// answers first; the platform default of 300s would truncate it. That flag lives
/// in sdp-infra, not this repo. See the timeout ladder in the crate README
/// (apps/sdp-helius-gateway/README.md) for the full chain and what each layer owns.
const PROVE_TIMEOUT: Duration = Duration::from_secs(660);
/// `/v1/wallets/sync`. Walks the indexer in several rounds, so it needs more than a
/// single round trip.
const SYNC_TIMEOUT: Duration = Duration::from_secs(60);
/// `/v1/operations/plan`. Plan is a sync plus input selection, so it is strictly
/// more work than `/v1/wallets/sync` and strictly less than a prove.
///
/// Equal to [`SYNC_TIMEOUT`] today and deliberately a separate constant: sharing one
/// would mean the next person to raise either budget silently raises both.
const PLAN_TIMEOUT: Duration = Duration::from_secs(60);
/// `/v1/wallets/register` and `/v1/operations/shield`. One on-chain registry read
/// each.
///
/// Above the agave RPC client's own 30-second per-request timeout, on purpose. Below
/// it, this layer always wins the race and SDP gets a bodyless `504` instead of the
/// structured `RPC_UNAVAILABLE` the transport error would have produced.
const RPC_TIMEOUT: Duration = Duration::from_secs(35);
/// `/v1/transactions/assemble`. Pure local work: no key material, no RPC, a function
/// of its request body.
const DEFAULT_TIMEOUT: Duration = Duration::from_secs(15);

/// A layer-level timeout that answers with `504`, matching how the handler-level
/// `PROVER_TIMEOUT` is reported.
///
/// `TimeoutLayer::new` is deprecated in tower-http 0.7 and defaults to `408`,
/// which would tell SDP the *client* was slow. A layer timeout cannot produce our
/// structured [`ErrorBody`], so handlers should prefer timing out internally; this
/// is the backstop for a handler that hangs.
///
/// [`ErrorBody`]: crate::error::ErrorBody
fn timeout(duration: Duration) -> TimeoutLayer {
    TimeoutLayer::with_status_code(StatusCode::GATEWAY_TIMEOUT, duration)
}

/// Builds the application router.
///
/// `/health` sits outside the signed router. A liveness probe carries no shared
/// secret, and requiring one would make an HMAC misconfiguration look like a dead
/// container instead of failing requests with a clear cause.
pub fn app(state: AppState) -> Router {
    // Keyless routes, signed by `sdp-api`. None of these ever receives key material,
    // which is why registration and the merge opt-in can be called directly rather
    // than through the key authority.
    let sdp_api = Router::new()
        .route(
            "/v1/wallets/register",
            post(register::handle).layer(timeout(RPC_TIMEOUT)),
        )
        // Same shape as register: one registry read, then build a transaction the
        // owner must sign.
        .route(
            "/v1/wallets/merging",
            post(merging::handle).layer(timeout(RPC_TIMEOUT)),
        )
        // Grouped with the other operations rather than with `/transactions`,
        // because SDP calls it when a user shields — it is the whole operation, not
        // a step in one.
        .route(
            "/v1/operations/shield",
            post(shield::handle).layer(timeout(RPC_TIMEOUT)),
        )
        .route(
            "/v1/transactions/assemble",
            post(assemble::handle).layer(timeout(DEFAULT_TIMEOUT)),
        )
        // Indexer-bound, so it borrows `SYNC_TIMEOUT` rather than introducing a
        // constant the ladder would have to order. A single nullifier lookup is
        // lighter than a full sync; a dedicated budget can come with the handler,
        // once there is something to measure.
        .route(
            "/v1/nullifiers/status",
            post(nullifiers::handle).layer(timeout(SYNC_TIMEOUT)),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::verify_sdp_api,
        ));

    // Key-bearing routes, signed by `rings-key-auth`. These are the requests whose
    // bodies the key authority has injected material into, so they are accepted only
    // from it — a tag made with the sdp-api secret is `UNAUTHORIZED` here.
    let key_auth = Router::new()
        .route(
            "/v1/wallets/sync",
            post(sync::handle).layer(timeout(SYNC_TIMEOUT)),
        )
        .route(
            "/v1/operations/plan",
            post(plan::handle).layer(timeout(PLAN_TIMEOUT)),
        )
        .route(
            "/v1/operations/prove",
            post(prove::handle).layer(timeout(PROVE_TIMEOUT)),
        )
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            auth::verify_key_auth,
        ));

    Router::new()
        .route("/health", get(health::handle))
        .merge(sdp_api)
        .merge(key_auth)
        // Bodies are buffered whole for HMAC verification, so this bound is what
        // caps memory per in-flight request.
        .layer(RequestBodyLimitLayer::new(MAX_BODY_BYTES))
        // Records method, path, status and latency. It must never be configured
        // to capture bodies or headers: request bodies carry viewing and
        // nullifier keys, and `x-hmac-signature` is a credential.
        .layer(TraceLayer::new_for_http())
        .with_state(state)
}

/// The agave RPC client's own per-request timeout. A route that waits less than this
/// converts every slow-RPC case into a bodyless `504`, discarding the
/// `RPC_UNAVAILABLE` the transport would have reported.
const AGAVE_HTTP_TIMEOUT_SECS: u64 = 30;

/// The outer half of the prove ladder, which lives outside this crate: the Cloud Run
/// service timeout, the SDP client that calls us, and the reconciler job that drives
/// it. Mirrored here so the ordering is checkable at all. See the timeout ladder in
/// apps/sdp-helius-gateway/README.md for what each layer owns.
const CLOUD_RUN_SERVICE_TIMEOUT_SECS: u64 = 700;
const SDP_OUTBOUND_CLIENT_TIMEOUT_SECS: u64 = 720;
const CLOUD_RUN_JOB_TASK_TIMEOUT_SECS: u64 = 780;

// The ladder, enforced at compile time.
//
// Only the innermost bound that fires can answer with a structured `ErrorBody`;
// every layer above it produces a bodyless `504` and leaves SDP to guess. So the
// budgets have to increase outward.
//
// A compile-time block rather than a test, because nothing asserted any of these
// numbers before and a false claim about the prover's ceiling survived in nine
// places. What it cannot check is whether sdp-infra actually applied 700 and 780; it
// pins this crate against the recorded intent.
const _: () = {
    assert!(
        DEFAULT_TIMEOUT.as_secs() <= RPC_TIMEOUT.as_secs(),
        "assemble is pure local work, so it must not outlast an RPC-bound route"
    );
    assert!(
        RPC_TIMEOUT.as_secs() <= SYNC_TIMEOUT.as_secs(),
        "a single registry read must not outlast a multi-round indexer walk"
    );
    assert!(
        SYNC_TIMEOUT.as_secs() <= PLAN_TIMEOUT.as_secs(),
        "plan is a sync plus selection, so it must have at least a sync's budget"
    );
    assert!(
        PLAN_TIMEOUT.as_secs() < PROVE_TIMEOUT.as_secs(),
        "a prove is the long call and must have the largest in-process budget"
    );

    assert!(
        RPC_TIMEOUT.as_secs() > AGAVE_HTTP_TIMEOUT_SECS,
        "an RPC-bound route must outwait the transport so its error can surface"
    );
    assert!(
        PROVE_TIMEOUT.as_secs() < CLOUD_RUN_SERVICE_TIMEOUT_SECS,
        "the layer timeout must answer before Cloud Run cuts the request"
    );
    assert!(
        CLOUD_RUN_SERVICE_TIMEOUT_SECS < SDP_OUTBOUND_CLIENT_TIMEOUT_SECS,
        "SDP must outwait the gateway, or it discards an answer already on the wire"
    );
    assert!(
        SDP_OUTBOUND_CLIENT_TIMEOUT_SECS < CLOUD_RUN_JOB_TASK_TIMEOUT_SECS,
        "the reconciler job must outlast the request it is driving"
    );
};
