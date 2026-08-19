//! Startup validation against the chain the gateway was configured to talk to.
//!
//! zolana crates are unpublished and pinned by git revision, so a breaking
//! account-layout change and a routine patch are indistinguishable from a version
//! number. That makes silent skew the realistic failure mode, and its symptom is a
//! decode error on a user's real operation.
//!
//! Preflight moves that discovery to boot, and `/health` keeps it visible.
//!
//! # What is fatal and what is not
//!
//! - **Unparseable program id** — fatal. Configuration is wrong.
//! - **Protocol config absent, or not the expected size** — fatal. Either this is
//!   the wrong chain (the shielded pool is not deployed on mainnet at all) or the
//!   layout moved under the pinned revision. Both must fail closed rather than
//!   proceed with a mismatched decoder.
//! - **RPC unreachable, or too slow to answer** — not fatal. A cold start during an
//!   RPC blip should not crashloop, and liveness must not depend on a third party.
//!   The gateway serves with `protocolConfig: null`, which is itself the alert.
//!   Both reads are bounded by `RPC_PROBE_TIMEOUT`, because "slow" is the shape a
//!   rate-limited endpoint takes and it would otherwise outlast the startup probe.

use std::time::Duration;

use solana_address::Address;
use zolana_client::rpc::AsyncRpc;
use zolana_client::solana_rpc::AsyncSolanaRpc;
use zolana_interface::pda;

use crate::config::Config;
use crate::wire::health::ProtocolConfigSnapshot;

/// Wall-clock bound on each preflight RPC read.
///
/// The agave client underneath applies a 30-second timeout per HTTP *attempt*
/// (`solana-rpc-client`'s `HttpSender::new`), then retries a `429` up to five times
/// honouring `Retry-After` up to 119 seconds. So a single `getAccount` against a
/// rate-limited endpoint can take around 13 minutes while never once being
/// "unreachable". Configuring a shorter client timeout would not help: it bounds
/// each attempt, and the retry sleeps sit above it. Only a wall-clock bound here
/// does.
///
/// Boot must not wait that long. Cloud Run gives a revision 240 seconds to start
/// listening, so a preflight that outlasts the probe turns "tolerate an RPC blip"
/// into a failed revision, which is the opposite of the policy above.
///
/// 10 seconds is a judgement rather than a measurement, but it has margin on both
/// sides: a devnet `getAccount` answers in well under a second, and the budgets
/// above it are 240 seconds (startup probe) and 30 seconds (first container
/// healthcheck). Raising it past ~30 seconds would mean raising the Dockerfile's
/// `--start-period` to match.
const RPC_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// On-chain size of the protocol config account.
///
/// Upstream builds this from `discriminator(1) + four addresses(128) + three
/// permission flags(3)`. Asserted here because a decoder built against the wrong
/// length fails on every real account, and a length check turns that into a boot
/// failure instead of a failure on someone's operation.
const PROTOCOL_CONFIG_SIZE: usize = 132;

/// Byte offsets of the permission flags, counted from the end of the account.
///
/// Read positionally rather than through a decoder so that the raw bytes stay
/// authoritative: if upstream reorders these fields, the `data` field in
/// [`ProtocolConfigSnapshot`] still shows the truth even when these booleans are
/// wrong.
const FLAG_RING_CREATION_FROM_END: usize = 2;
const FLAG_SPL_INTERFACE_FROM_END: usize = 1;

/// Why the gateway must not start.
#[derive(Debug, thiserror::Error)]
pub enum PreflightError {
    /// The configured program id is not a valid address.
    #[error("EXPECTED_SHIELDED_POOL_PROGRAM_ID is not a valid address")]
    InvalidProgramId,

    /// The configured program id is not the one the pinned zolana revision
    /// derives its PDAs from, so every PDA this build computes would be wrong.
    #[error(
        "configured shielded pool {configured} does not match the pinned zolana revision's {expected}"
    )]
    ProgramIdMismatch {
        /// From the environment.
        configured: String,
        /// Compiled into the pinned zolana revision.
        expected: String,
    },

    /// The protocol config account does not exist at the derived PDA.
    #[error("protocol config account {0} does not exist — wrong cluster?")]
    ProtocolConfigMissing(String),

    /// The account exists but is not the expected size.
    #[error("protocol config is {actual} bytes, expected {PROTOCOL_CONFIG_SIZE} — layout skew")]
    ProtocolConfigSize {
        /// Observed length.
        actual: usize,
    },
}

/// Validates configuration and, when reachable, snapshots on-chain state.
///
/// Returns `Ok(None)` when RPC was unreachable — see the module docs for why that
/// is tolerated.
pub async fn run(config: &Config) -> Result<Option<ProtocolConfigSnapshot>, PreflightError> {
    let configured: Address = config
        .shielded_pool_program_id
        .parse()
        .map_err(|_| PreflightError::InvalidProgramId)?;

    // The PDA helpers use a program id baked into the pinned revision. If the
    // operator points us at a different deployment, every PDA we derive silently
    // belongs to the wrong program.
    let expected = pda::shielded_pool_program_id();
    if configured.as_array() != expected.as_array() {
        return Err(PreflightError::ProgramIdMismatch {
            configured: configured.to_string(),
            expected: expected.to_string(),
        });
    }

    let address = Address::new_from_array(pda::protocol_config().to_bytes());
    let rpc = AsyncSolanaRpc::new(config.solana_rpc_url.clone());

    let account = match tokio::time::timeout(RPC_PROBE_TIMEOUT, rpc.get_account(address)).await {
        Ok(Ok(account)) => account,
        Ok(Err(error)) => {
            tracing::warn!(
                %error,
                %address,
                "preflight could not reach RPC; serving without a protocol-config snapshot"
            );
            return Ok(None);
        }
        // Distinct from the error arm: a rate-limited endpoint answers slowly rather
        // than not at all, and the two want different operator responses.
        Err(_elapsed) => {
            tracing::warn!(
                %address,
                timeout_secs = RPC_PROBE_TIMEOUT.as_secs(),
                "preflight RPC read did not answer in time; serving without a protocol-config snapshot"
            );
            return Ok(None);
        }
    };

    let account =
        account.ok_or_else(|| PreflightError::ProtocolConfigMissing(address.to_string()))?;

    if account.data.len() != PROTOCOL_CONFIG_SIZE {
        return Err(PreflightError::ProtocolConfigSize {
            actual: account.data.len(),
        });
    }

    // Best-effort: a failed or slow slot read must not fail the boot, since the
    // account read already succeeded and it is the account that matters. Zero means
    // "unknown", the same as before this read was bounded.
    let slot = match tokio::time::timeout(RPC_PROBE_TIMEOUT, rpc.get_slot()).await {
        Ok(Ok(slot)) => slot,
        Ok(Err(_)) => 0,
        Err(_elapsed) => {
            tracing::warn!(
                timeout_secs = RPC_PROBE_TIMEOUT.as_secs(),
                "preflight slot read did not answer in time; reporting slot 0"
            );
            0
        }
    };

    let len = account.data.len();
    let snapshot = ProtocolConfigSnapshot {
        address: address.to_string(),
        data: base64_standard(&account.data),
        data_len: len as u32,
        slot,
        ring_creation_is_permissionless: account.data[len - FLAG_RING_CREATION_FROM_END] != 0,
        spl_interface_creation_is_permissionless: account.data[len - FLAG_SPL_INTERFACE_FROM_END]
            != 0,
    };

    tracing::info!(
        ring_creation_is_permissionless = snapshot.ring_creation_is_permissionless,
        spl_interface_creation_is_permissionless =
            snapshot.spl_interface_creation_is_permissionless,
        slot = snapshot.slot,
        "preflight ok"
    );

    Ok(Some(snapshot))
}

fn base64_standard(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}
