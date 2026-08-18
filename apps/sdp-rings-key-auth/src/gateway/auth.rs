//! Outbound HMAC signing compatible with sidecar PR 1290.

use hmac::{Hmac, KeyInit as _, Mac as _};
use sha2::Sha256;

use crate::error::ServiceError;
use crate::ports::GatewayAuthHeaders;

/// Sidecar timestamp header.
pub const TIMESTAMP_HEADER: &str = "x-timestamp";
/// Sidecar signature header.
pub const SIGNATURE_HEADER: &str = "x-hmac-signature";

type HmacSha256 = Hmac<Sha256>;

/// Signs the exact bytes `timestamp + raw_body` with HMAC-SHA256.
pub fn sign(secret: &[u8], timestamp: &str, body: &[u8]) -> Result<String, ServiceError> {
    let mut mac = HmacSha256::new_from_slice(secret).map_err(|_| ServiceError::internal())?;
    mac.update(timestamp.as_bytes());
    mac.update(body);

    let tag = mac.finalize().into_bytes();
    let mut encoded = String::with_capacity(tag.len() * 2);
    for byte in tag {
        use std::fmt::Write as _;
        write!(&mut encoded, "{byte:02x}").map_err(|_| ServiceError::internal())?;
    }
    Ok(encoded)
}

/// Builds the two headers expected by the sidecar.
pub fn headers(
    secret: &[u8],
    unix_timestamp: u64,
    body: &[u8],
) -> Result<GatewayAuthHeaders, ServiceError> {
    let timestamp = unix_timestamp.to_string();
    let signature = sign(secret, &timestamp, body)?;
    Ok(GatewayAuthHeaders {
        timestamp,
        signature,
    })
}
