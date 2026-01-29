/**
 * Signing Service
 *
 * Domain service for managing signing operations and provider resolution.
 * Handles 3-tier config resolution (project → org → env) and async signing flows.
 */

import {
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  type SigningConfigRecord,
  createSigningAdapter,
  createSigningAdapterFromConfig,
} from "@/services/adapters";
import { type EncryptionService, createEncryptionService } from "@/services/encryption.service";
import type { SignRequest, SignResult, SignStatus, SigningPort } from "@/services/ports";
import { SigningError } from "@/services/ports";
import {
  CustodyConfigStore,
  type CustodyWallet,
  SigningRequestD1Store,
} from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { getBase58Codec } from "@solana/codecs";
import {
  type Address,
  type KeyPairSigner,
  type TransactionSigner,
  generateKeyPairSigner,
} from "@solana/kit";

const base58 = getBase58Codec();

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Store interface for signing configuration records.
 * Abstracted to decouple from D1 specifics.
 */
export interface SigningConfigStore {
  findActive(orgId: string, projectId?: string): Promise<SigningConfigRecord | null>;
  getById(configId: string): Promise<SigningConfigRecord | null>;
  upsert(
    orgId: string,
    projectId: string | undefined,
    config: SigningConfiguration
  ): Promise<string>;
}

/**
 * Store interface for async signing request tracking.
 */
export interface SigningRequestStore {
  create(params: CreateSigningRequestParams): Promise<string>;
  findByIdOrExternal(requestId: string): Promise<SigningRequestRecord | null>;
  updateStatus(id: string, status: SignStatus): Promise<void>;
}

export interface CreateSigningRequestParams {
  organizationId: string;
  custodyConfigId: string;
  externalRequestId: string;
  transactionMessage: string;
  metadata?: Record<string, unknown>;
}

export interface SigningRequestRecord {
  id: string;
  organizationId: string;
  custodyConfigId: string;
  externalRequestId: string | null;
  status: "pending" | "completed" | "rejected" | "failed";
  transactionMessage: string;
  signatures: string | null;
  metadata: string | null;
}

/**
 * Signing configuration (union of provider-specific configs)
 */
export interface SigningConfiguration {
  provider: "local" | "fireblocks";
  defaultWalletId?: string;
  // Provider-specific fields stored in encrypted config JSON
}

/**
 * Options for initializing org signing with local provider.
 */
export interface InitLocalSigningOptions {
  /** Optional label for the root wallet */
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Fireblocks provider.
 */
export interface InitFireblocksSigningOptions {
  apiKey: string;
  apiSecretPem: string;
  vaultAccountId: string;
  assetId?: string;
  apiBaseUrl?: string;
}

/**
 * Result of initializing org signing.
 */
export interface InitSigningResult {
  configId: string;
  publicKey: Address;
  walletId: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Implementation
// ═══════════════════════════════════════════════════════════════════════════

const ENV_FALLBACK_CONFIG_ID = "env_fallback";

/**
 * Domain service for signing operations.
 * Manages provider resolution, initialization, and async signing coordination.
 */
export class SigningService {
  private providerCache = new Map<string, SigningPort>();
  private encryptionService: EncryptionService | null = null;

  constructor(
    private configStore: SigningConfigStore & {
      createWallet: CustodyConfigStore["createWallet"];
      getWallets: CustodyConfigStore["getWallets"];
    },
    private signingStore: SigningRequestStore,
    private env: Env
  ) {}

  /**
   * Get the encryption service, lazily initialized.
   * Required for storing encrypted private keys.
   */
  private getEncryptionService(): EncryptionService {
    if (!this.encryptionService) {
      this.encryptionService = createEncryptionService(this.env.CUSTODY_ENCRYPTION_KEY);
    }
    return this.encryptionService;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Organization Signing Initialization
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Initialize signing for an organization with the local provider.
   *
   * Generates a new keypair, encrypts the private key, and stores
   * the configuration in the database.
   *
   * @param orgId - Organization ID
   * @param projectId - Optional project ID for project-specific config
   * @param options - Optional configuration options
   * @returns The new config ID, public key, and wallet ID
   */
  async initializeLocalSigning(
    orgId: string,
    projectId?: string,
    options?: InitLocalSigningOptions
  ): Promise<InitSigningResult> {
    // Check if config already exists
    const existing = await this.configStore.findActive(orgId, projectId);
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    // Generate a new keypair
    const keypair = await generateKeyPairSigner();

    // Get the full 64-byte secret key and encode as base58
    // The keypair.keyPair contains the CryptoKeyPair
    const privateKeyBytes = await exportKeypairBytes(keypair);
    const privateKeyBase58 = base58.encode(privateKeyBytes);

    // Encrypt the private key for storage
    const encryption = this.getEncryptionService();
    const encryptedKey = await encryption.encryptPrivateKey(orgId, privateKeyBase58);

    // Create config with encrypted private key
    const configJson: LocalProviderConfig = {
      provider: "local",
      encryptedPrivateKey: encryptedKey,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "local",
      defaultWalletId: keypair.address,
    });

    // Update the config with the encrypted JSON
    // Note: We store the encrypted config separately from the schema-level fields
    await this.updateConfigJson(configId, configJson);

    // Create wallet record
    await this.configStore.createWallet(configId, {
      walletId: keypair.address,
      publicKey: keypair.address,
      label: options?.walletLabel ?? "Root Signing Wallet",
      purpose: "root",
    });

    // Invalidate cache
    const cacheKey = `${orgId}:${projectId ?? "org"}`;
    this.providerCache.delete(cacheKey);

    return {
      configId,
      publicKey: keypair.address,
      walletId: keypair.address,
    };
  }

  /**
   * Initialize signing for an organization with Fireblocks provider.
   *
   * @param orgId - Organization ID
   * @param projectId - Optional project ID for project-specific config
   * @param options - Fireblocks configuration
   * @returns The new config ID, public key, and wallet ID
   */
  async initializeFireblocksSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitFireblocksSigningOptions
  ): Promise<InitSigningResult> {
    // Check if config already exists
    const existing = await this.configStore.findActive(orgId, projectId);
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    // Encrypt the API secret for storage
    const encryption = this.getEncryptionService();
    const encryptedSecret = await encryption.encryptPrivateKey(orgId, options.apiSecretPem);

    // Create config with Fireblocks credentials
    const configJson: FireblocksProviderConfig = {
      provider: "fireblocks",
      apiKey: options.apiKey,
      apiSecretEncrypted: encryptedSecret,
      vaultAccountId: options.vaultAccountId,
      assetId: options.assetId ?? "SOL",
      apiBaseUrl: options.apiBaseUrl,
    };

    // Create the adapter to get the public key
    const adapter = new KeychainFireblocksAdapter({
      apiKey: options.apiKey,
      apiSecretPem: options.apiSecretPem,
      vaultAccountId: options.vaultAccountId,
      assetId: options.assetId ?? "SOL",
      apiBaseUrl: options.apiBaseUrl,
    });

    const publicKey = await adapter.getPublicKey();
    const walletId = `fb_${options.vaultAccountId}`;

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "fireblocks",
      defaultWalletId: walletId,
    });

    // Update the config with the encrypted JSON
    await this.updateConfigJson(configId, configJson);

    // Create wallet record
    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: "Fireblocks Vault",
      purpose: "root",
    });

    // Invalidate cache
    const cacheKey = `${orgId}:${projectId ?? "org"}`;
    this.providerCache.delete(cacheKey);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Get the wallets for an organization's custody config.
   */
  async getWallets(orgId: string, projectId?: string): Promise<CustodyWallet[]> {
    const config = await this.configStore.findActive(orgId, projectId);
    if (!config) {
      return [];
    }
    return this.configStore.getWallets(config.id);
  }

  /**
   * Update the encrypted config JSON for a custody config.
   * This is a private helper - the public API uses initializeLocalSigning/initializeFireblocksSigning.
   */
  private async updateConfigJson(
    configId: string,
    config: LocalProviderConfig | FireblocksProviderConfig
  ): Promise<void> {
    // This would normally be a direct DB update, but we'll use the upsert pattern
    // The config JSON is stored in the `config` column of custody_configs
    const configStore = this.configStore as CustodyConfigStore;
    const existing = await configStore.getById(configId);
    if (!existing) {
      throw new SigningError("Config not found", "NOT_FOUND");
    }

    // Direct D1 update for the config JSON
    // This is safe because we're only updating our own config
    const db = this.env.DB;
    await db
      .prepare("UPDATE custody_configs SET config = ?, updated_at = datetime('now') WHERE id = ?")
      .bind(JSON.stringify(config), configId)
      .run();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the signing adapter for an organization/project.
   *
   * Resolution order:
   * 1. Project-specific config (if projectId provided)
   * 2. Organization-level config
   * 3. Environment fallback (KeychainMemoryAdapter with CUSTODY_PRIVATE_KEY)
   */
  async getAdapter(orgId: string, projectId?: string): Promise<SigningPort> {
    const cacheKey = `${orgId}:${projectId ?? "org"}`;

    const cached = this.providerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const config = await this.configStore.findActive(orgId, projectId);

    // If we have a config, use the encrypted config handler
    // This decrypts private keys before creating the adapter
    let adapter: SigningPort;
    if (config) {
      adapter = await createAdapterFromEncryptedConfig(this.env, orgId, config);
    } else {
      // Fall back to environment-based adapter
      adapter = await createSigningAdapter(this.env, null);
    }

    this.providerCache.set(cacheKey, adapter);
    return adapter;
  }

  /**
   * Get the public key for the signing wallet.
   */
  async getPublicKey(orgId: string, projectId?: string, walletId?: string): Promise<Address> {
    const adapter = await this.getAdapter(orgId, projectId);
    return adapter.getPublicKey(walletId);
  }

  /**
   * Get a KeyPairSigner for backward compatibility.
   * Only works with KeychainMemoryAdapter.
   */
  async getKeypairSigner(orgId: string, projectId?: string): Promise<KeyPairSigner> {
    const adapter = await this.getAdapter(orgId, projectId);

    if (adapter instanceof KeychainMemoryAdapter) {
      return adapter.getTransactionSigner();
    }

    throw new SigningError(
      `KeyPairSigner not available for provider type: ${adapter.providerId}. Use getTransactionSigner() instead.`,
      "INVALID_REQUEST"
    );
  }

  /**
   * Get a transaction signer compatible with @solana/kit.
   * Works with both KeychainMemoryAdapter and KeychainFireblocksAdapter.
   *
   * Returns a TransactionSigner that can be used with:
   * - signTransactionMessageWithSigners()
   * - partiallySignTransactionMessageWithSigners()
   * - addSignersToTransactionMessage()
   */
  async getTransactionSigner(orgId: string, projectId?: string): Promise<TransactionSigner> {
    const adapter = await this.getAdapter(orgId, projectId);

    if (adapter instanceof KeychainMemoryAdapter) {
      return adapter.getTransactionSigner();
    }

    if (adapter instanceof KeychainFireblocksAdapter) {
      return adapter.getTransactionSigner();
    }

    throw new SigningError(
      `TransactionSigner not available for provider type: ${adapter.providerId}`,
      "INVALID_REQUEST"
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Signing Operations
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Sign a transaction message using the configured adapter.
   * Handles both sync (local) and async (Fireblocks) flows.
   */
  async sign(
    orgId: string,
    projectId: string | undefined,
    request: SignRequest
  ): Promise<SignResult> {
    const adapter = await this.getAdapter(orgId, projectId);
    const result = await adapter.sign(request);

    // Track async signing requests
    if (result.status === "pending" && result.requestId) {
      const config = await this.configStore.findActive(orgId, projectId);
      const configId = config?.id ?? ENV_FALLBACK_CONFIG_ID;

      await this.signingStore.create({
        organizationId: orgId,
        custodyConfigId: configId,
        externalRequestId: result.requestId,
        transactionMessage: encodeBase64(request.message),
        metadata: request.metadata,
      });
    }

    return result;
  }

  /**
   * Check the status of an async signing request.
   */
  async getSigningStatus(requestId: string): Promise<SignStatus> {
    const record = await this.signingStore.findByIdOrExternal(requestId);

    if (!record) {
      return { status: "failed", error: "Signing request not found" };
    }

    // Return cached status if already resolved
    if (record.status === "completed" && record.signatures) {
      // Parse signatures from JSON (stored as address → base64 signature pairs)
      const signaturesJson = JSON.parse(record.signatures) as Array<{
        publicKey: string;
        signature: string;
      }>;
      const signatures = new Map<Address, Uint8Array>();
      for (const { publicKey, signature } of signaturesJson) {
        signatures.set(publicKey as Address, decodeBase64(signature));
      }
      return { status: "completed", signatures };
    }

    if (record.status === "rejected") {
      return { status: "rejected", reason: "Request was rejected" };
    }

    if (record.status === "failed") {
      return { status: "failed", error: "Signing failed" };
    }

    // Query the provider for current status
    if (record.custodyConfigId === ENV_FALLBACK_CONFIG_ID) {
      // Env fallback should never have pending requests
      return { status: "failed", error: "Invalid signing request state" };
    }

    const config = await this.configStore.getById(record.custodyConfigId);
    if (!config) {
      return { status: "failed", error: "Custody configuration not found" };
    }

    // Use encrypted config handler to properly decrypt credentials
    const adapter = await createAdapterFromEncryptedConfig(this.env, record.organizationId, config);

    if (!adapter.getSignStatus) {
      return { status: "pending" };
    }

    const externalId = record.externalRequestId ?? requestId;
    const providerStatus = await adapter.getSignStatus(externalId);

    // Persist resolved status
    if (providerStatus.status !== "pending") {
      await this.signingStore.updateStatus(record.id, providerStatus);
    }

    return providerStatus;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Configuration Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Configure the signing provider for an org/project.
   */
  async configureProvider(
    orgId: string,
    projectId: string | undefined,
    config: SigningConfiguration
  ): Promise<void> {
    await this.configStore.upsert(orgId, projectId, config);

    // Invalidate cache
    const cacheKey = `${orgId}:${projectId ?? "org"}`;
    this.providerCache.delete(cacheKey);
  }

  /**
   * Get the current signing configuration.
   */
  async getConfiguration(orgId: string, projectId?: string): Promise<SigningConfigRecord | null> {
    return this.configStore.findActive(orgId, projectId);
  }

  /**
   * Check if the current provider requires async approval.
   */
  async requiresApproval(orgId: string, projectId?: string): Promise<boolean> {
    const adapter = await this.getAdapter(orgId, projectId);
    return adapter.requiresApproval();
  }

  /**
   * Invalidate cached adapter for an org/project.
   * Call this after key rotation or config updates to force re-resolution.
   */
  invalidateCache(orgId: string, projectId?: string): void {
    const cacheKey = `${orgId}:${projectId ?? "org"}`;
    this.providerCache.delete(cacheKey);
  }

  /**
   * Clear all cached adapters.
   * Useful for testing or when multiple configs may have changed.
   */
  clearAllCaches(): void {
    this.providerCache.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function decodeBase64(base64: string): Uint8Array {
  const normalized = base64.replace(/-/g, "+").replace(/_/g, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = atob(`${normalized}${padding}`);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Export the secret key bytes from a KeyPairSigner.
 * Returns the 64-byte secret key (32 private + 32 public).
 */
async function exportKeypairBytes(signer: KeyPairSigner): Promise<Uint8Array> {
  // KeyPairSigner wraps a CryptoKeyPair, we need to export the private key
  // The keyPair property contains the underlying CryptoKeyPair
  const keyPair = (signer as { keyPair: CryptoKeyPair }).keyPair;

  // Export the private key in PKCS8 format and extract the raw bytes
  // pkcs8 format always returns ArrayBuffer (not JsonWebKey)
  const exported = (await crypto.subtle.exportKey("pkcs8", keyPair.privateKey)) as ArrayBuffer;
  const pkcs8Bytes = new Uint8Array(exported);

  // PKCS8 for Ed25519 has a specific structure:
  // 30 2e (SEQUENCE, 46 bytes)
  //   02 01 00 (INTEGER, version 0)
  //   30 05 (SEQUENCE, 5 bytes - AlgorithmIdentifier)
  //     06 03 2b6570 (OID 1.3.101.112 = Ed25519)
  //   04 22 (OCTET STRING, 34 bytes)
  //     04 20 (OCTET STRING, 32 bytes - the actual private key seed)
  //       <32 bytes of private key seed>
  // Total: 48 bytes for the outer structure

  // The private key seed starts at offset 16 (0-indexed) for Ed25519
  // Verify the structure matches Ed25519 PKCS8
  if (pkcs8Bytes.length !== 48) {
    throw new SigningError(`Unexpected PKCS8 key length: ${pkcs8Bytes.length}`, "INVALID_REQUEST");
  }

  // Extract the 32-byte private seed
  const privateSeed = pkcs8Bytes.slice(16, 48);

  // Export the public key (raw format always returns ArrayBuffer)
  const publicKeyExported = (await crypto.subtle.exportKey(
    "raw",
    keyPair.publicKey
  )) as ArrayBuffer;
  const publicKeyBytes = new Uint8Array(publicKeyExported);

  // Combine into Solana's 64-byte keypair format (seed + public)
  const combined = new Uint8Array(64);
  combined.set(privateSeed);
  combined.set(publicKeyBytes, 32);

  return combined;
}

// ═══════════════════════════════════════════════════════════════════════════
// Provider Config Types (stored as encrypted JSON)
// ═══════════════════════════════════════════════════════════════════════════

interface LocalProviderConfig {
  provider: "local";
  encryptedPrivateKey: string;
}

interface FireblocksProviderConfig {
  provider: "fireblocks";
  apiKey: string;
  apiSecretEncrypted: string;
  vaultAccountId: string;
  assetId: string;
  apiBaseUrl?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a SigningService instance from environment bindings.
 *
 * This factory wires up the D1-backed stores and creates a fully
 * functional SigningService ready for use in request handlers.
 *
 * @param env - Cloudflare Worker environment bindings
 * @returns Configured SigningService instance
 */
export function createSigningService(env: Env): SigningService {
  const configStore = new CustodyConfigStore(env.DB);
  const signingStore = new SigningRequestD1Store(env.DB);

  return new SigningService(configStore, signingStore, env);
}

// ═══════════════════════════════════════════════════════════════════════════
// Enhanced Adapter Creation (with decryption support)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a signing adapter from a database config record with decryption.
 *
 * This version handles decrypting the stored private key for local providers
 * before creating the adapter.
 *
 * @param env - Environment for encryption key
 * @param orgId - Organization ID for key derivation
 * @param record - Config record from database
 * @returns Configured SigningPort adapter
 */
export async function createAdapterFromEncryptedConfig(
  env: Env,
  orgId: string,
  record: SigningConfigRecord
): Promise<SigningPort> {
  const parsed = JSON.parse(record.config) as LocalProviderConfig | FireblocksProviderConfig;

  // biome-ignore lint/nursery/noSecrets: This is a type guard, not a secret
  if (parsed.provider === "local" && "encryptedPrivateKey" in parsed) {
    // Decrypt the private key
    const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
    const privateKeyBase58 = await encryption.decryptPrivateKey(orgId, parsed.encryptedPrivateKey);

    // Create adapter with decrypted key
    return KeychainMemoryAdapter.fromBase58(privateKeyBase58);
  }

  // biome-ignore lint/nursery/noSecrets: This is a type guard, not a secret
  if (parsed.provider === "fireblocks" && "apiSecretEncrypted" in parsed) {
    // Decrypt the API secret
    const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
    const apiSecretPem = await encryption.decryptPrivateKey(orgId, parsed.apiSecretEncrypted);

    // Create Fireblocks adapter with decrypted secret
    return new KeychainFireblocksAdapter({
      apiKey: parsed.apiKey,
      apiSecretPem,
      vaultAccountId: parsed.vaultAccountId,
      assetId: parsed.assetId,
      apiBaseUrl: parsed.apiBaseUrl,
    });
  }

  // Fall back to standard config creation (for backward compatibility)
  return createSigningAdapterFromConfig(record, env);
}
