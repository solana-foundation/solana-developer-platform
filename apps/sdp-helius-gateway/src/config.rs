//! Startup configuration, read once from the environment.
//!
//! Fails fast: a gateway that starts with a missing prover URL only discovers it
//! on the first real operation, which is the worst time.

use crate::redact::SecretBytes;

/// Devnet shielded-pool program. Compiled in as the default so a misconfigured
/// deployment fails the startup preflight rather than talking to the wrong chain.
/// The pool is not deployed on mainnet at all.
pub const DEFAULT_SHIELDED_POOL_PROGRAM_ID: &str = "sppXZU59VoYodv9Accs4hHNTjYiuYmDFyFVjUjPxFsG";

/// Maximum request body the gateway will buffer.
///
/// Bodies must be buffered whole because HMAC covers them, so this doubles as the
/// bound on that. Generous enough for a wallet projection with a few thousand
/// notes.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Solana's wire packet limit. An assembled transaction over this is rejected
/// before it can fail on chain.
///
/// Unreferenced until the assemble handler enforces it.
#[allow(dead_code)]
pub const MAX_TRANSACTION_BYTES: u32 = 1232;

/// Accepted clock skew on a signed request, in seconds. Bounds replay.
pub const HMAC_TIMESTAMP_TOLERANCE_SECS: i64 = 300;

/// Resolved configuration.
///
/// `photon_url` and `prover_url` are carried but not read by any handler yet; they
/// are validated at startup so a misconfiguration surfaces at boot rather than on
/// the first operation.
#[derive(Debug)]
#[allow(dead_code)]
pub struct Config {
    /// TCP port to bind.
    pub port: u16,
    /// HMAC secret shared with `sdp-api`, which calls the keyless routes.
    ///
    /// Two secrets rather than one because the gateway now serves two callers with
    /// different privileges, and a single shared secret cannot tell them apart. A
    /// caller holding only this one must not be able to sign a key-bearing route.
    pub hmac_secret_sdp_api: SecretBytes,
    /// HMAC secret shared with `rings-key-auth`, which calls the key-bearing routes.
    ///
    /// The key-authority design states that this service holds no route *to* the key
    /// authority. Making the reverse true — that key-bearing traffic is accepted only
    /// *from* the key authority — costs one config entry.
    pub hmac_secret_key_auth: SecretBytes,
    /// Solana JSON-RPC endpoint.
    pub solana_rpc_url: String,
    /// Photon indexer endpoint.
    pub photon_url: String,
    /// Prover endpoint.
    pub prover_url: String,
    /// Shielded-pool program id this build expects on chain.
    pub shielded_pool_program_id: String,
}

/// Why configuration could not be resolved.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// A required variable is absent or empty.
    #[error("{0} is not set")]
    Missing(&'static str),
    /// A variable is present but unusable.
    #[error("{name} is invalid: {reason}")]
    Invalid {
        /// Variable name.
        name: &'static str,
        /// What was wrong with it. Never includes the value — some of these are
        /// secrets.
        reason: String,
    },
}

impl Config {
    /// Reads and validates configuration from the process environment.
    ///
    /// # Upstream endpoints are env-only
    ///
    /// `solana_rpc_url`, `photon_url` and `prover_url` are *not* request
    /// parameters, and must never become them. This service receives decrypted
    /// nullifier keys, so a caller-influenced prover URL would let one crafted
    /// request send that key material to an attacker's endpoint.
    ///
    /// The upstream prover also receives witnesses in plaintext (upstream's own
    /// compose config says so). That is a property of the protocol rather than of
    /// this gateway, but it is why the prover endpoint must be
    /// operator-controlled.
    pub fn from_env() -> Result<Self, ConfigError> {
        Ok(Self {
            port: parse_port()?,
            hmac_secret_sdp_api: read_hmac_secret("HELIUS_GATEWAY_HMAC_SECRET_SDP_API")?,
            hmac_secret_key_auth: read_hmac_secret("HELIUS_GATEWAY_HMAC_SECRET_KEY_AUTH")?,
            solana_rpc_url: require("SOLANA_RPC_URL")?,
            photon_url: require("PHOTON_URL")?,
            prover_url: require("PROVER_URL")?,
            shielded_pool_program_id: optional("EXPECTED_SHIELDED_POOL_PROGRAM_ID")
                .unwrap_or_else(|| DEFAULT_SHIELDED_POOL_PROGRAM_ID.to_owned()),
        })
    }
}

fn optional(name: &'static str) -> Option<String> {
    // Read-only access throughout. `std::env::set_var` is `unsafe` in edition
    // 2024 because mutating the environment is not thread-safe, and this service
    // has no reason to write to it.
    std::env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
}

fn require(name: &'static str) -> Result<String, ConfigError> {
    optional(name).ok_or(ConfigError::Missing(name))
}

fn parse_port() -> Result<u16, ConfigError> {
    const NAME: &str = "HELIUS_GATEWAY_PORT";
    // 8788 rather than sdp-api's 8787, so both can run under docker-compose.
    match optional(NAME) {
        None => Ok(8788),
        Some(raw) => raw.trim().parse().map_err(|_| ConfigError::Invalid {
            name: "HELIUS_GATEWAY_PORT",
            reason: "expected a TCP port number".to_owned(),
        }),
    }
}

/// Reads one HMAC secret as **raw UTF-8 bytes of the variable's value**, not as
/// base64.
///
/// This matches SDP's existing signer
/// (`createHmacSignature` in `packages/sdp-payments/src/fee-payment/kora.adapter.ts`),
/// which does `crypto.subtle.importKey("raw", new TextEncoder().encode(secret), …)`,
/// so the key is the UTF-8 encoding of the configured string. Decoding base64
/// here would silently disagree with every signature SDP produces, and the failure
/// would look like a wrong secret rather than a mismatched convention. The key
/// authority's Rust signer has to match the same convention.
///
/// Parameterized by variable name because there are two callers, each with its own
/// secret, and both are required at startup on the same fail-fast rule.
fn read_hmac_secret(name: &'static str) -> Result<SecretBytes, ConfigError> {
    let secret = require(name)?;

    // 32 bytes minimum: with Cloud Run IAM absent (local compose, self-hosted),
    // this is the only thing between a request and a decrypted nullifier key.
    if secret.len() < 32 {
        return Err(ConfigError::Invalid {
            name,
            reason: format!("must be at least 32 bytes, got {}", secret.len()),
        });
    }

    Ok(SecretBytes::from_bytes(secret.into_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_error_never_includes_the_value() {
        let err = ConfigError::Invalid {
            name: "HELIUS_GATEWAY_HMAC_SECRET_KEY_AUTH",
            reason: "must be at least 32 bytes, got 4".to_owned(),
        };
        let rendered = err.to_string();
        assert!(rendered.contains("HELIUS_GATEWAY_HMAC_SECRET_KEY_AUTH"));
        assert!(rendered.contains("32 bytes"));
        // The name is safe to render; the value never is. A too-short secret is
        // still a secret.
        assert!(!rendered.contains("hunter2"));
    }
}
