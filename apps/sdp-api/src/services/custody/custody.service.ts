/**
 * Custody Service
 *
 * High-level service for managing custody providers and signing operations.
 * Handles provider resolution (project → org → env fallback), signing coordination,
 * and async signing request tracking.
 */

import type { Env } from "@/types/env";
import type { Address, KeyPairSigner } from "@solana/kit";

import { CustodyConfigStore } from "./config-store";
import { LocalKeypairProvider } from "./local-keypair.provider";
import { type CustodyProviderRegistry, createDefaultRegistry } from "./provider-registry";
import { SigningRequestStore } from "./signing-request-store";
import type {
  CustodyConfigRecord,
  CustodyConfiguration,
  CustodyProvider,
  CustodySignResult,
  SignRequest,
  SignatureStatus,
} from "./types";

const ENV_FALLBACK_CONFIG_ID = "env_fallback";

export class CustodyService {
  private configStore: CustodyConfigStore;
  private signingStore: SigningRequestStore;
  private providerRegistry: CustodyProviderRegistry;
  private providerCache = new Map<string, CustodyProvider>();

  constructor(
    db: D1Database,
    private env: Env,
    registry?: CustodyProviderRegistry
  ) {
    this.configStore = new CustodyConfigStore(db);
    this.signingStore = new SigningRequestStore(db);
    this.providerRegistry = registry ?? createDefaultRegistry();
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Provider Resolution
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Get the custody provider for an organization/project.
   *
   * Resolution order:
   * 1. Project-specific config (if projectId provided)
   * 2. Organization-level config
   * 3. Environment fallback (LocalKeypairProvider with CUSTODY_PRIVATE_KEY)
   */
  async getProvider(orgId: string, projectId?: string): Promise<CustodyProvider> {
    const cacheKey = `${orgId}:${projectId ?? "org"}`;

    const cached = this.providerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const config = await this.configStore.findActive(orgId, projectId);
    const provider = config
      ? this.providerRegistry.createProvider(config, this.env)
      : this.createEnvFallbackProvider();

    this.providerCache.set(cacheKey, provider);
    return provider;
  }

  /**
   * Get a KeyPairSigner for backward compatibility with existing code.
   * Only works with LocalKeypairProvider.
   */
  async getKeypairSigner(orgId: string, projectId?: string): Promise<KeyPairSigner> {
    const provider = await this.getProvider(orgId, projectId);

    if (provider instanceof LocalKeypairProvider) {
      return provider.getKeypairSigner();
    }

    throw new Error(
      `KeyPairSigner not available for provider type: ${provider.providerId}. Use signTransaction() for external custody providers.`
    );
  }

  /**
   * Get the public key for the custody wallet.
   */
  async getPublicKey(orgId: string, projectId?: string, walletId?: string): Promise<Address> {
    const provider = await this.getProvider(orgId, projectId);
    return provider.getPublicKey(walletId);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Signing Operations
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Sign a transaction using the configured custody provider.
   * Handles both sync (local) and async (institutional) signing flows.
   */
  async signTransaction(
    orgId: string,
    projectId: string | undefined,
    request: SignRequest
  ): Promise<CustodySignResult> {
    const provider = await this.getProvider(orgId, projectId);

    const response = await provider.sign(request);

    if (response.status === "pending_approval" && response.signatureRequestId) {
      const config = await this.configStore.findActive(orgId, projectId);
      const configId = config?.id ?? ENV_FALLBACK_CONFIG_ID;

      await this.signingStore.create({
        organizationId: orgId,
        custodyConfigId: configId,
        externalRequestId: response.signatureRequestId,
        transactionMessage: request.transactionMessage,
        metadata: request.metadata,
      });

      return {
        completed: false,
        signingRequestId: response.signatureRequestId,
        status: "pending_approval",
      };
    }

    if (response.status === "completed" && response.signatures) {
      return {
        completed: true,
        status: "completed",
      };
    }

    return {
      completed: false,
      status: response.status,
      error: response.error ?? "Signing failed",
    };
  }

  /**
   * Check the status of an async signing request.
   */
  async getSigningStatus(requestId: string): Promise<SignatureStatus> {
    const record = await this.signingStore.findByIdOrExternal(requestId);

    if (!record) {
      return { status: "failed", error: "Signing request not found" };
    }

    if (record.status === "completed" && record.signatures) {
      return {
        status: "completed",
        signatures: JSON.parse(record.signatures),
      };
    }

    if (record.status === "rejected") {
      return { status: "rejected", reason: "Request was rejected" };
    }

    if (record.status === "failed") {
      return { status: "failed", error: "Signing failed" };
    }

    if (record.custodyConfigId === ENV_FALLBACK_CONFIG_ID) {
      return { status: "failed", error: "Custody configuration not found" };
    }

    const config = await this.configStore.getById(record.custodyConfigId);
    if (!config) {
      return { status: "failed", error: "Custody configuration not found" };
    }

    const provider = this.providerRegistry.createProvider(config, this.env);

    if (!provider.getSignatureStatus) {
      return { status: "pending" };
    }

    const externalId = record.externalRequestId ?? requestId;
    const providerStatus = await provider.getSignatureStatus(externalId);

    if (providerStatus.status !== "pending") {
      await this.signingStore.updateStatus(record.id, providerStatus);
    }

    return providerStatus;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Configuration Management
  // ═════════════════════════════════════════════════════════════════════════

  async configureCustody(
    orgId: string,
    projectId: string | undefined,
    config: CustodyConfiguration
  ): Promise<void> {
    await this.configStore.upsert(orgId, projectId, config);

    const cacheKey = `${orgId}:${projectId ?? "org"}`;
    this.providerCache.delete(cacheKey);
  }

  async getCustodyConfiguration(
    orgId: string,
    projectId?: string
  ): Promise<CustodyConfigRecord | null> {
    return this.configStore.findActive(orgId, projectId);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Private Helpers
  // ═════════════════════════════════════════════════════════════════════════

  private createEnvFallbackProvider(): CustodyProvider {
    if (!this.env.CUSTODY_PRIVATE_KEY) {
      throw new Error(
        "Custody not configured. Set CUSTODY_PRIVATE_KEY or configure a custody provider."
      );
    }

    return new LocalKeypairProvider(this.env);
  }
}
