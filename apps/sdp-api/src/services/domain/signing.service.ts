/**
 * Signing Service
 *
 * Domain service for managing signing operations and provider resolution.
 * Handles 3-tier config resolution (project → org → env) and async signing flows.
 */

import {
  LocalKeypairAdapter,
  type SigningConfigRecord,
  createSigningAdapter,
} from "@/services/adapters";
import type { SignRequest, SignResult, SignStatus, SigningPort } from "@/services/ports";
import { SigningError } from "@/services/ports";
import type { Env } from "@/types/env";
import type { Address, KeyPairSigner } from "@solana/kit";

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
  // Provider-specific fields...
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Implementation
// ═══════════════════════════════════════════════════════════════════════════

const ENV_FALLBACK_CONFIG_ID = "env_fallback";

/**
 * Domain service for signing operations.
 * Manages provider resolution and async signing coordination.
 */
export class SigningService {
  private providerCache = new Map<string, SigningPort>();

  constructor(
    private configStore: SigningConfigStore,
    private signingStore: SigningRequestStore,
    private env: Env
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the signing adapter for an organization/project.
   *
   * Resolution order:
   * 1. Project-specific config (if projectId provided)
   * 2. Organization-level config
   * 3. Environment fallback (LocalKeypairAdapter with CUSTODY_PRIVATE_KEY)
   */
  async getAdapter(orgId: string, projectId?: string): Promise<SigningPort> {
    const cacheKey = `${orgId}:${projectId ?? "org"}`;

    const cached = this.providerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const config = await this.configStore.findActive(orgId, projectId);
    const adapter = createSigningAdapter(this.env, config);

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
   * Only works with LocalKeypairAdapter.
   */
  async getKeypairSigner(orgId: string, projectId?: string): Promise<KeyPairSigner> {
    const adapter = await this.getAdapter(orgId, projectId);

    if (adapter instanceof LocalKeypairAdapter) {
      return adapter.getKeypairSigner();
    }

    throw new SigningError(
      `KeyPairSigner not available for provider type: ${adapter.providerId}. Use sign() for external custody providers.`,
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

    const adapter = createSigningAdapter(this.env, config);

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
