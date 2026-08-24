//! Request authentication.
//!
//! # Why there is no JWT verification here
//!
//! In production this service runs on Cloud Run with `--no-allow-unauthenticated`
//! and `roles/run.invoker` granted only to the SDP API's service account. Google's
//! front end validates the caller's OIDC identity token and rejects unauthenticated
//! requests *before* they reach this container. Verifying the token again in-process
//! would mean fetching and caching JWKS to re-derive a decision the platform has
//! already made and enforced.
//!
//! # What HMAC adds
//!
//! Peer identity is not the whole problem. HMAC over `timestamp + body` gives:
//!
//! - **body integrity** — IAM authenticates the caller, not the bytes;
//! - **a bounded replay window** — see [`HMAC_TIMESTAMP_TOLERANCE_SECS`];
//! - **an auth path that exists off Cloud Run** — docker-compose, self-hosted
//!   deployments and integration tests have no IAM front end at all.
//!
//! The scheme matches SDP's existing signer byte for byte
//! (`createHmacSignature` in `packages/sdp-payments/src/fee-payment/kora.adapter.ts`):
//! HMAC-SHA256, key is the UTF-8 bytes of the shared secret, message is the
//! decimal-seconds timestamp concatenated with the raw body, signature is
//! lowercase hex. The key authority's Rust signer has to match the same scheme.
//!
//! # Two callers, one secret each
//!
//! The gateway serves `sdp-api` on the keyless routes and `rings-key-auth` on the
//! key-bearing ones. Each route is verified against **its own caller's secret only,
//! never "either"** — a key-bearing route signed with the sdp-api secret is
//! `UNAUTHORIZED`. The key-authority design states that this service holds no route
//! *to* the key authority; making the reverse true costs one config entry.
//!
//! In production Cloud Run IAM already separates the two service accounts, so this is
//! defence in depth there. It is the **only** such control in docker-compose,
//! self-hosted deployments and integration tests — which is the same gap that makes
//! HMAC worth having at all.
//!
//! # Why not a nested or origin signature
//!
//! Because the key authority mutates the body. `sdp-api`'s signature over the body
//! *it* composed cannot be re-derived here from the final bytes: JSON
//! re-serialization is not byte-stable, and this service cannot know what was added.
//!
//! The property such a scheme would reach for is proof that `sdp-api` authored the
//! action, and the key authority already provides it — `sdp-api` presents a
//! single-use intent token naming the exact operation, and the key authority
//! independently verifies that the operation exists, is approved, and is in a
//! provable state *before* unwrapping. This gateway sits downstream of that decision
//! and has no authority to refuse on it, so re-verifying the token here would add a
//! dependency without adding a control.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::body::{Body, Bytes};
use axum::extract::{Request, State};
use axum::middleware::Next;
use axum::response::Response;
// `KeyInit` carries `new_from_slice`. In hmac 0.13 it is re-exported from
// `digest`; older snippets that only import `Mac` do not compile.
use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use subtle::ConstantTimeEq;

use crate::config::{HMAC_TIMESTAMP_TOLERANCE_SECS, MAX_BODY_BYTES};
use crate::error::GatewayError;
use crate::state::AppState;

/// Header carrying unix seconds.
pub const TIMESTAMP_HEADER: &str = "x-timestamp";
/// Header carrying the lowercase-hex HMAC-SHA256 tag.
pub const SIGNATURE_HEADER: &str = "x-hmac-signature";

type HmacSha256 = Hmac<Sha256>;

/// Middleware for the routes `sdp-api` calls: everything that carries no key
/// material.
pub async fn verify_sdp_api(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, GatewayError> {
    let secret = state.config.hmac_secret_sdp_api.clone();
    verify(secret.expose(), request, next).await
}

/// Middleware for the routes `rings-key-auth` calls: everything that carries key
/// material.
///
/// Separate from [`verify_sdp_api`] rather than parameterized at the call site,
/// because axum's `from_fn_with_state` takes a plain async fn — and because two named
/// entry points make the route table in [`crate::routes`] state which caller each
/// route expects.
pub async fn verify_key_auth(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Result<Response, GatewayError> {
    let secret = state.config.hmac_secret_key_auth.clone();
    verify(secret.expose(), request, next).await
}

/// Verifies the request signature against one caller's secret, then passes the
/// request on.
///
/// The body must be buffered whole because it is covered by the signature, so
/// this is also where the body-size bound is enforced.
async fn verify(secret: &[u8], request: Request, next: Next) -> Result<Response, GatewayError> {
    let (parts, body) = request.into_parts();

    let timestamp = parts
        .headers
        .get(TIMESTAMP_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(GatewayError::Unauthorized)?
        .to_owned();

    let signature = parts
        .headers
        .get(SIGNATURE_HEADER)
        .and_then(|value| value.to_str().ok())
        .ok_or(GatewayError::Unauthorized)?
        .to_owned();

    let bytes = axum::body::to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| GatewayError::InvalidRequest("body exceeded the size limit".to_owned()))?;

    check_timestamp(&timestamp)?;
    check_signature(secret, &timestamp, &bytes, &signature)?;

    Ok(next
        .run(Request::from_parts(parts, Body::from(bytes)))
        .await)
}

/// Rejects a timestamp outside the tolerance window in either direction.
///
/// Both directions matter: a future timestamp is as suspicious as a stale one,
/// and allowing it would widen the replay window for a caller with a skewed
/// clock.
fn check_timestamp(raw: &str) -> Result<(), GatewayError> {
    let claimed: i64 = raw.trim().parse().map_err(|_| GatewayError::Unauthorized)?;

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| GatewayError::Internal("system clock is before the unix epoch".into()))?
        .as_secs() as i64;

    // `abs_diff` is unsigned, so i64::MIN cannot overflow the window check
    // the way `(now - claimed).abs()` does.
    if now.abs_diff(claimed) > HMAC_TIMESTAMP_TOLERANCE_SECS as u64 {
        return Err(GatewayError::Unauthorized);
    }
    Ok(())
}

/// Recomputes the tag over `timestamp + body` and compares in constant time.
fn check_signature(
    secret: &[u8],
    timestamp: &str,
    body: &Bytes,
    presented_hex: &str,
) -> Result<(), GatewayError> {
    let presented = decode_hex(presented_hex).ok_or(GatewayError::Unauthorized)?;

    let mut mac = HmacSha256::new_from_slice(secret)
        .map_err(|_| GatewayError::Internal("hmac key rejected".into()))?;
    mac.update(timestamp.as_bytes());
    mac.update(body);
    let expected = mac.finalize().into_bytes();

    // Constant-time: a byte-wise early return would leak the tag one byte at a
    // time to a caller who can measure response latency.
    if expected.as_slice().ct_eq(&presented).into() {
        Ok(())
    } else {
        Err(GatewayError::Unauthorized)
    }
}

fn decode_hex(input: &str) -> Option<Vec<u8>> {
    if !input.len().is_multiple_of(2) {
        return None;
    }
    input
        .as_bytes()
        .chunks(2)
        .map(|pair| {
            let text = std::str::from_utf8(pair).ok()?;
            u8::from_str_radix(text, 16).ok()
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const SECRET: &[u8] = b"a-shared-secret-of-at-least-32-bytes";
    /// The other caller's secret. Verification must be against one secret, not
    /// either, so a tag made with this one must fail against [`SECRET`].
    const OTHER_SECRET: &[u8] = b"the-other-callers-secret-32-bytes-min";

    /// Mirrors SDP's signer, so these tests double as a check that the two
    /// implementations agree on the message construction.
    fn sign(timestamp: &str, body: &[u8]) -> String {
        sign_with(SECRET, timestamp, body)
    }

    fn sign_with(secret: &[u8], timestamp: &str, body: &[u8]) -> String {
        let mut mac = HmacSha256::new_from_slice(secret).unwrap();
        mac.update(timestamp.as_bytes());
        mac.update(body);
        mac.finalize()
            .into_bytes()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }

    fn now() -> String {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            .to_string()
    }

    #[test]
    fn rejects_a_signature_from_the_other_caller() {
        // The whole point of two secrets: a caller who can sign the keyless routes
        // must not be able to sign a key-bearing one. Verification is against one
        // secret, never "either".
        let timestamp = now();
        let body = br#"{"requestId":"op_1"}"#;
        let forged = sign_with(OTHER_SECRET, &timestamp, body);

        assert!(
            check_signature(SECRET, &timestamp, &Bytes::from_static(body), &forged).is_err(),
            "a tag made with the other caller's secret must not verify"
        );
        // …and it is a valid tag, just not for this secret.
        assert!(
            check_signature(OTHER_SECRET, &timestamp, &Bytes::from_static(body), &forged).is_ok(),
            "sanity: the tag is well-formed for its own secret"
        );
    }

    #[test]
    fn accepts_a_correct_signature() {
        let body = Bytes::from_static(b"{\"requestId\":\"op_1\"}");
        let ts = now();
        let sig = sign(&ts, &body);
        assert!(check_signature(SECRET, &ts, &body, &sig).is_ok());
    }

    #[test]
    fn rejects_a_tampered_body() {
        let ts = now();
        let sig = sign(&ts, b"{\"amount\":\"1\"}");
        let tampered = Bytes::from_static(b"{\"amount\":\"1000000\"}");
        assert!(check_signature(SECRET, &ts, &tampered, &sig).is_err());
    }

    #[test]
    fn rejects_a_signature_bound_to_a_different_timestamp() {
        let body = Bytes::from_static(b"{}");
        let sig = sign("1700000000", &body);
        assert!(check_signature(SECRET, "1700000001", &body, &sig).is_err());
    }

    #[test]
    fn rejects_a_stale_or_future_timestamp() {
        let now: i64 = now().parse().unwrap();
        let stale = (now - HMAC_TIMESTAMP_TOLERANCE_SECS - 1).to_string();
        let ahead = (now + HMAC_TIMESTAMP_TOLERANCE_SECS + 1).to_string();

        assert!(check_timestamp(&stale).is_err());
        assert!(check_timestamp(&ahead).is_err());
        assert!(check_timestamp(&now.to_string()).is_ok());
    }

    #[test]
    fn rejects_extreme_timestamps_without_overflow() {
        assert!(check_timestamp(&i64::MIN.to_string()).is_err());
        assert!(check_timestamp(&i64::MAX.to_string()).is_err());
    }

    #[test]
    fn rejects_malformed_hex() {
        assert!(decode_hex("abc").is_none(), "odd length");
        assert!(decode_hex("zz").is_none(), "not hex");
        assert_eq!(decode_hex("00ff"), Some(vec![0x00, 0xff]));
    }
}
