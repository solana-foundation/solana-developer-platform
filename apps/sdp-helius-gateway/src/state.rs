//! Shared handler state.
//!
//! The gateway holds no wallet state, no cursor, and no cache of anything derived
//! from a request. Only immutable configuration and the startup preflight
//! snapshot. Anything more would be state SDP no longer owns.

use std::sync::Arc;

use crate::config::Config;
use crate::wire::health::ProtocolConfigSnapshot;

/// Cloneable handle to process-wide state.
#[derive(Clone)]
pub struct AppState {
    /// Resolved configuration.
    pub config: Arc<Config>,
    /// What the on-chain protocol config said at startup.
    ///
    /// Read once rather than per request: it is a skew check, not live data, and
    /// re-reading it on every `/health` hit would make a liveness probe depend on
    /// RPC availability.
    pub protocol_config: Arc<Option<ProtocolConfigSnapshot>>,
}

impl AppState {
    /// Builds state from resolved configuration and a preflight result.
    pub fn new(config: Config, protocol_config: Option<ProtocolConfigSnapshot>) -> Self {
        Self {
            config: Arc::new(config),
            protocol_config: Arc::new(protocol_config),
        }
    }
}
