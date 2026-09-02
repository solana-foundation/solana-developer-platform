//! Startup configuration.

/// Maximum request body accepted by the key authority.
pub const MAX_BODY_BYTES: usize = 4 * 1024 * 1024;

/// Resolved process configuration.
#[derive(Clone, Copy, Debug)]
pub struct Config {
    /// TCP port to bind.
    pub port: u16,
}

impl Config {
    /// Constructs configuration from already validated values.
    pub const fn new(port: u16) -> Result<Self, ConfigError> {
        if port == 0 {
            return Err(ConfigError::ZeroPort);
        }
        Ok(Self { port })
    }

    /// Reads configuration from the environment.
    pub fn from_env() -> Result<Self, ConfigError> {
        let port = match std::env::var("RINGS_KEY_AUTH_PORT") {
            Ok(raw) => raw
                .trim()
                .parse::<u16>()
                .map_err(|_| ConfigError::InvalidPort)?,
            Err(std::env::VarError::NotPresent) => 8789,
            Err(std::env::VarError::NotUnicode(_)) => return Err(ConfigError::InvalidPort),
        };

        Self::new(port)
    }
}

/// Configuration resolution failure.
#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    /// The configured port was not a valid TCP port.
    #[error("RINGS_KEY_AUTH_PORT must be a valid TCP port")]
    InvalidPort,
    /// Port zero requests an ephemeral bind and cannot be health-checked.
    #[error("RINGS_KEY_AUTH_PORT must not be zero")]
    ZeroPort,
}
