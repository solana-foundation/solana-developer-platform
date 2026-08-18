//! Shared application state.

use std::sync::Arc;

use crate::config::Config;
use crate::ports::{RejectingStageAuthorizer, StageAuthorizer};

/// Production adapter availability exposed by health.
#[derive(Clone, Copy, Debug, Default)]
pub struct AdapterReadiness {
    /// Whether a stage authorizer is installed.
    pub stage_authorizer: bool,
    /// Whether encrypted key storage is installed.
    pub key_store: bool,
    /// Whether an envelope cipher is installed.
    pub envelope_cipher: bool,
    /// Whether a live gateway client is installed.
    pub gateway_client: bool,
}

impl AdapterReadiness {
    /// True only when every capability required for key operations is installed.
    pub const fn all_ready(self) -> bool {
        self.stage_authorizer && self.key_store && self.envelope_cipher && self.gateway_client
    }
}

/// Immutable state shared by all routes.
#[derive(Clone)]
pub struct AppState {
    /// Process configuration.
    pub config: Config,
    /// Availability of intentionally deferred production adapters.
    pub adapters: AdapterReadiness,
    authorizer: Arc<dyn StageAuthorizer>,
}

impl AppState {
    /// Constructs the fail-closed skeleton state.
    pub fn new(config: Config) -> Self {
        Self {
            config,
            adapters: AdapterReadiness {
                stage_authorizer: false,
                key_store: false,
                envelope_cipher: false,
                gateway_client: false,
            },
            authorizer: Arc::new(RejectingStageAuthorizer),
        }
    }

    /// Constructs state with a concrete stage authorizer.
    ///
    /// This is used by contract tests today and is the production wiring point
    /// once the stage-token format is settled.
    pub fn with_authorizer(config: Config, authorizer: Arc<dyn StageAuthorizer>) -> Self {
        let mut state = Self::new(config);
        state.adapters.stage_authorizer = true;
        state.authorizer = authorizer;
        state
    }

    /// Stage capability verifier.
    pub fn authorizer(&self) -> &dyn StageAuthorizer {
        self.authorizer.as_ref()
    }
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AppState")
            .field("config", &self.config)
            .field("adapters", &self.adapters)
            .field("authorizer", &"[capability]")
            .finish()
    }
}
