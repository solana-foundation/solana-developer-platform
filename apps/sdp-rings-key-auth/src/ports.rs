//! Capability interfaces for deferred production adapters.

use std::fmt;

use async_trait::async_trait;
use zeroize::ZeroizeOnDrop;

use crate::domain::keys::KeyMaterial;
use crate::error::ServiceError;
use crate::wire::api::StageEnvelope;
use crate::wire::gateway::{GatewayPlanResponse, GatewayProveResponse, GatewaySyncResponse};

/// Opaque stage capability supplied by SDP.
#[derive(ZeroizeOnDrop)]
pub struct StageToken(String);

impl StageToken {
    /// Creates a bounded non-empty token.
    pub fn new(token: String) -> Result<Self, ServiceError> {
        if token.is_empty() || token.len() > 8 * 1024 {
            return Err(ServiceError::unauthorized());
        }
        Ok(Self(token))
    }

    /// Borrows the token for verification.
    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for StageToken {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("StageToken([redacted])")
    }
}

/// Verifies that a capability authorizes the exact immutable stage envelope.
#[async_trait]
pub trait StageAuthorizer: Send + Sync {
    /// Authorizes one request stage. Implementations must verify every envelope
    /// field rather than only token validity.
    async fn authorize(
        &self,
        token: &StageToken,
        envelope: &StageEnvelope,
    ) -> Result<(), ServiceError>;
}

/// Production-safe default used until a real verifier is installed.
pub struct RejectingStageAuthorizer;

#[async_trait]
impl StageAuthorizer for RejectingStageAuthorizer {
    async fn authorize(
        &self,
        _token: &StageToken,
        _envelope: &StageEnvelope,
    ) -> Result<(), ServiceError> {
        Err(ServiceError::adapter_unavailable("stageAuthorizer"))
    }
}

/// Tenant and wallet binding used as envelope-encryption AAD.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeyContext {
    /// Tenant boundary.
    pub organization_id: String,
    /// Stable Rings wallet ID.
    pub wallet_id: String,
}

/// Ciphertext persisted by the key store.
#[derive(ZeroizeOnDrop)]
pub struct EncryptedWalletKeys {
    /// Monotonic record version used for compare-and-swap updates.
    pub record_version: u64,
    /// Secret ciphertext.
    pub ciphertext: Vec<u8>,
    /// KMS-wrapped data-encryption key.
    pub wrapped_dek: Vec<u8>,
    /// KEK version identifier.
    pub kek_version: String,
}

impl fmt::Debug for EncryptedWalletKeys {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EncryptedWalletKeys")
            .field("record_version", &self.record_version)
            .field("ciphertext", &"[redacted]")
            .field("wrapped_dek", &"[redacted]")
            .field("kek_version", &self.kek_version)
            .finish()
    }
}

/// Dedicated key-authority database seam.
#[async_trait]
pub trait KeyStore: Send + Sync {
    /// Reads one encrypted wallet record.
    async fn load(&self, context: &KeyContext) -> Result<EncryptedWalletKeys, ServiceError>;

    /// Atomically creates one encrypted wallet record.
    async fn create(
        &self,
        context: &KeyContext,
        encrypted: EncryptedWalletKeys,
    ) -> Result<(), ServiceError>;

    /// Atomically replaces a record after viewing-key rotation.
    async fn replace(
        &self,
        context: &KeyContext,
        expected_record_version: u64,
        encrypted: EncryptedWalletKeys,
    ) -> Result<(), ServiceError>;
}

/// Envelope-encryption seam; production implementations may use GCP KMS.
#[async_trait]
pub trait EnvelopeCipher: Send + Sync {
    /// Encrypts material with organization and wallet bound as AAD.
    async fn encrypt(
        &self,
        context: &KeyContext,
        material: KeyMaterial,
    ) -> Result<EncryptedWalletKeys, ServiceError>;

    /// Unwraps and decrypts material for one request stage.
    async fn decrypt(
        &self,
        context: &KeyContext,
        encrypted: EncryptedWalletKeys,
    ) -> Result<KeyMaterial, ServiceError>;
}

/// Outbound authentication headers for the sidecar.
#[derive(Debug, Eq, PartialEq)]
pub struct GatewayAuthHeaders {
    /// Decimal Unix timestamp.
    pub timestamp: String,
    /// Lowercase hexadecimal HMAC-SHA256.
    pub signature: String,
}

/// Serialized sidecar body containing transient plaintext key material.
#[derive(ZeroizeOnDrop)]
pub struct SecretBody(Vec<u8>);

impl SecretBody {
    /// Takes ownership of a freshly serialized request body.
    pub fn new(bytes: Vec<u8>) -> Self {
        Self(bytes)
    }

    /// Borrows the exact bytes covered by the outbound HMAC.
    pub fn expose(&self) -> &[u8] {
        &self.0
    }
}

impl fmt::Debug for SecretBody {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "SecretBody([redacted]; {} bytes)", self.0.len())
    }
}

/// Stateless sidecar forwarding seam.
#[async_trait]
pub trait GatewayClient: Send + Sync {
    /// Sends a typed sync request body.
    async fn sync(
        &self,
        body: SecretBody,
        authentication: GatewayAuthHeaders,
    ) -> Result<GatewaySyncResponse, ServiceError>;

    /// Sends a typed planning request body.
    async fn plan(
        &self,
        body: SecretBody,
        authentication: GatewayAuthHeaders,
    ) -> Result<GatewayPlanResponse, ServiceError>;

    /// Sends a typed proving request body.
    async fn prove(
        &self,
        body: SecretBody,
        authentication: GatewayAuthHeaders,
    ) -> Result<GatewayProveResponse, ServiceError>;
}
