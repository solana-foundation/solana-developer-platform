/**
 * Signing Service
 *
 * Domain service for managing signing operations and provider resolution.
 * Handles DB-backed config resolution (project default → org default) and async signing flows.
 */

import type { CustodyProvider } from "@sdp/custody";
import {
  normalizeAnchorageWalletId,
  normalizeCoinbaseCdpWalletId,
  normalizeIbmHavenWalletId,
  normalizeParaWalletId,
  normalizePrivyWalletId,
  normalizeTurnkeyWalletId,
  normalizeUtilaWalletId,
} from "@sdp/custody";
import {
  createDfnsApiClient,
  createIbmHavenApiClient,
  IBM_HAVEN_PROVIDER_LABEL,
  normalizeDfnsWalletId,
  resolveDfnsNetwork,
} from "@sdp/custody/dfns";
import type { SigningPort, SignRequest, SignResult, SignStatus } from "@sdp/custody/signing";
import { isFullSigningPort, SigningError } from "@sdp/custody/signing";
import { getBase58Codec } from "@solana/codecs";
import type { Address, KeyPairSigner, TransactionSigner } from "@solana/kit";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/signers";
import { getDb } from "@/db";
import { parsePostgresJson } from "@/db/postgres-utils";
import { AppError } from "@/lib/errors";
import { enabledCustodyConnectionProviders } from "@/lib/feature-flags";
import {
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  type SigningConfigRecord,
} from "@/services/adapters";
import {
  CredentialSecretStoreError,
  createCredentialSecretStore,
} from "@/services/credential-secret-store";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import {
  assertCustodyProviderCanCreateWallet,
  assertCustodyProviderCanDeleteWallet,
  assertCustodyProviderCanSign,
  custodyProviderCanSign,
  shouldSetCustodyScopeDefault,
} from "@/services/custody-provider-lifecycle.service";
import {
  createAdapterFromEncryptedConfig,
  createPrivyAdapterFromCredential,
} from "@/services/domain/signing/provider-adapter-factory";
import {
  type AnchorageProviderConfig,
  type CoinbaseCdpProviderConfig,
  type DfnsProviderConfig,
  type FireblocksProviderConfig,
  type IbmHavenProviderConfig,
  type LocalProviderConfig,
  type ParaProviderConfig,
  type PrivyProviderConfig,
  parseConfigRecord,
  type TurnkeyProviderConfig,
  type UtilaProviderConfig,
} from "@/services/domain/signing/provider-config";
import {
  createProviderWallet,
  deleteProviderWallet,
} from "@/services/domain/signing/provider-wallet-lifecycle";
import {
  assertProviderAvailable,
  getProviderAvailability,
} from "@/services/provider-availability.service";
import {
  CustodyConfigStore,
  type CustodyWallet,
  SigningRequestStorePg,
  type WalletPurpose,
} from "@/services/stores/custody-config.store";
import {
  type CustodyConnectionRuntimeRecord,
  CustodyConnectionRuntimeStore,
  type CustodyWalletOwner,
  isUsableCustodyConnection,
} from "@/services/stores/custody-connection-runtime.store";
import type { Env } from "@/types/env";

export { createAdapterFromEncryptedConfig };

const base58 = getBase58Codec();

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Store interface for signing configuration records.
 * Abstracted to decouple from the underlying database implementation.
 */
export interface SigningConfigStore {
  findActive(orgId: string, projectId?: string): Promise<SigningConfigRecord | null>;
  listActive(orgId: string, projectId?: string): Promise<SigningConfigRecord[]>;
  findByProvider(
    orgId: string,
    projectId: string | undefined,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord | null>;
  findActiveByProvider(
    orgId: string,
    projectId: string | undefined,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord | null>;
  getDefaultConfig(orgId: string, projectId?: string): Promise<SigningConfigRecord | null>;
  setDefaultConfig(orgId: string, projectId: string | undefined, configId: string): Promise<void>;
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
  tokenTransactionId?: string | null;
  externalRequestId: string;
  transactionMessage: string;
  metadata?: Record<string, unknown>;
}

export interface SigningRequestRecord {
  id: string;
  organizationId: string;
  custodyConfigId: string;
  tokenTransactionId?: string | null;
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
  provider: CustodyProvider;
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
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Privy provider.
 */
export interface InitPrivySigningOptions {
  requestDelayMs?: number;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Coinbase CDP provider.
 */
export interface InitCoinbaseCdpSigningOptions {
  network?: "solana" | "solana-devnet";
  accountPolicy?: string;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Para provider.
 */
export interface InitParaSigningOptions {
  requestDelayMs?: number;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Turnkey provider.
 */
export interface InitTurnkeySigningOptions {
  requestDelayMs?: number;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with DFNS provider.
 */
export interface InitDfnsSigningOptions {
  network?: "Solana" | "SolanaDevnet";
  walletLabel?: string;
}

/**
 * Options for initializing org signing with IBM Digital Asset Haven.
 *
 * IBM Digital Asset Haven is a white-label Dfns deployment; credentials are
 * platform-managed via IBM_HAVEN_* env bindings.
 */
export interface InitIbmHavenSigningOptions {
  network?: "Solana" | "SolanaDevnet";
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Anchorage provider.
 *
 * Anchorage currently supports wallet lifecycle only (create/delete), not signing.
 */
export interface InitAnchorageSigningOptions {
  walletLabel?: string;
  network?: "solana" | "solana-devnet";
}

/**
 * Options for initializing org signing with Utila provider.
 *
 * Utila is platform-managed: SDP creates a new Solana sub-wallet inside the
 * configured vault, like the other hosted providers.
 */
export interface InitUtilaSigningOptions {
  /** Optional label for the first wallet created in the vault. */
  walletLabel?: string;
}

/**
 * Result of initializing org signing.
 */
export interface InitSigningResult {
  configId: string;
  publicKey: Address;
  walletId: string;
}

type ReusableSigningProvider = "privy" | "coinbase_cdp" | "para" | "turnkey" | "utila";

export type ProviderReuseState = Record<ReusableSigningProvider, boolean>;

export interface SigningConfigurationsResult {
  configs: SigningConfigRecord[];
  defaultConfigId: string | null;
}

export interface ConnectionTargetSwitchResult {
  kind: "connection";
  connectionId: string;
  wallet: CustodyWallet;
}

export interface CustodyWalletWithProvider extends CustodyWallet {
  provider: SigningConfiguration["provider"];
  isDefaultProvider: boolean;
}

interface ListWalletsOptions {
  provider?: SigningConfiguration["provider"];
  includeAllProviders?: boolean;
}

type PrivyConnectionClassification =
  | { kind: "absent" }
  | { kind: "pending"; connection: CustodyConnectionRuntimeRecord }
  | { kind: "active"; connection: CustodyConnectionRuntimeRecord };

interface PrivyCredentialAuthentication {
  appId: string;
  appSecret: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Service Implementation
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Domain service for signing operations.
 * Manages provider resolution, initialization, and async signing coordination.
 */
export class SigningService {
  private providerCache = new Map<string, SigningPort>();
  private custodyCipher: CustodyCipher | null = null;

  constructor(
    private configStore: SigningConfigStore & {
      createWallet: CustodyConfigStore["createWallet"];
      getWallets: CustodyConfigStore["getWallets"];
      getWalletsForConfigs: CustodyConfigStore["getWalletsForConfigs"];
      deactivateWallet: CustodyConfigStore["deactivateWallet"];
      deactivateWalletIfNotLast: CustodyConfigStore["deactivateWalletIfNotLast"];
      reactivateWallet: CustodyConfigStore["reactivateWallet"];
    },
    private signingStore: SigningRequestStore,
    private env: Env,
    private connectionStore?: CustodyConnectionRuntimeStore
  ) {}

  private getConnectionStore(): CustodyConnectionRuntimeStore {
    if (!this.connectionStore) {
      this.connectionStore = new CustodyConnectionRuntimeStore(
        getDb(this.env),
        enabledCustodyConnectionProviders(this.env)
      );
    }
    return this.connectionStore;
  }

  private connectionRuntimeEnabled(projectId: string | undefined): projectId is string {
    return Boolean(projectId) && this.connectionProviderEnabled("privy");
  }

  private connectionProviderEnabled(provider: CustodyProvider): boolean {
    return enabledCustodyConnectionProviders(this.env).some(
      (enabledProvider) => enabledProvider === provider
    );
  }

  /**
   * Get the encryption service, lazily initialized.
   * Required for storing encrypted private keys.
   */
  private getCustodyCipher(): CustodyCipher {
    if (!this.custodyCipher) {
      this.custodyCipher = createCustodyCipher(this.env);
    }
    return this.custodyCipher;
  }

  private async assertProviderEnabled(
    orgId: string,
    provider: SigningConfiguration["provider"]
  ): Promise<void> {
    try {
      await assertProviderAvailable(this.env, getDb(this.env), orgId, "custody", provider);
    } catch (error) {
      if (error instanceof AppError) {
        throw new SigningError(error.message, "INVALID_REQUEST", error);
      }
      throw error;
    }
  }

  private async ensureScopeDefaultConfig(
    orgId: string,
    projectId: string | undefined,
    configId: string,
    provider: SigningConfiguration["provider"]
  ): Promise<void> {
    const scopeDefault = await this.configStore.getDefaultConfig(orgId, projectId);

    if (
      !shouldSetCustodyScopeDefault({
        candidateProvider: provider,
        currentDefaultProvider: scopeDefault?.provider ?? null,
      })
    ) {
      return;
    }

    await this.configStore.setDefaultConfig(orgId, projectId, configId);
  }

  private async ensureScopeDefaultConfigForExistingRecord(
    orgId: string,
    projectId: string | undefined,
    configId: string
  ): Promise<void> {
    const config = await this.configStore.getById(configId);
    if (!config) {
      return;
    }

    const scopeDefault = await this.configStore.getDefaultConfig(orgId, projectId);
    if (
      shouldSetCustodyScopeDefault({
        candidateProvider: config.provider,
        currentDefaultProvider: scopeDefault?.provider ?? null,
      })
    ) {
      await this.configStore.setDefaultConfig(orgId, projectId, configId);
    }
  }

  private async getScopeAndFallbackConfigs(
    orgId: string,
    projectId: string | undefined
  ): Promise<SigningConfigRecord[]> {
    const scopedConfigs = await this.configStore.listActive(orgId, projectId);
    if (!projectId) {
      return scopedConfigs;
    }

    const orgConfigs = await this.configStore.listActive(orgId, undefined);
    const scopedConfigIds = new Set(scopedConfigs.map((config) => config.id));
    return [...scopedConfigs, ...orgConfigs.filter((config) => !scopedConfigIds.has(config.id))];
  }

  private async classifyPrivyConnection(
    orgId: string,
    projectId: string
  ): Promise<PrivyConnectionClassification> {
    const connections = await this.getConnectionStore().listProjectConnections(orgId, projectId);
    const live = connections.filter((connection) => connection.status !== "deactivated");

    if (live.length === 0) {
      if (connections.length === 0) {
        return { kind: "absent" };
      }
      throw new SigningError("Privy custody Connection is not usable", "CONFLICT");
    }
    if (live.length !== 1) {
      throw new SigningError("Privy custody Connection is ambiguous", "CONFLICT");
    }

    const connection = live[0] as CustodyConnectionRuntimeRecord;
    if (
      connection.status === "pending" &&
      connection.lastCheckStatus === "success" &&
      connection.credentialStatus === "active" &&
      connection.defaultCustodyWalletId === null
    ) {
      return { kind: "pending", connection };
    }
    if (isUsableCustodyConnection(connection)) {
      return { kind: "active", connection };
    }

    throw new SigningError("Privy custody Connection is not usable", "CONFLICT");
  }

  private async assertPrivyConnectionWalletCreationEntitled(orgId: string): Promise<void> {
    const availability = await getProviderAvailability(this.env, getDb(this.env), orgId);
    if (!availability.providers.custody.privy.entitled) {
      throw new AppError(
        "FORBIDDEN",
        "Stored credential provisioning is disabled for this provider"
      );
    }
  }

  private async readPrivyCredential(
    connection: CustodyConnectionRuntimeRecord
  ): Promise<PrivyCredentialAuthentication> {
    try {
      const secretStore = createCredentialSecretStore(
        this.env,
        connection.credentialStorageBackend
      );
      const payload = await secretStore.read({
        orgId: connection.organizationId,
        stored: {
          storageBackend: connection.credentialStorageBackend,
          secretRef: connection.credentialSecretRef ?? undefined,
          secretVersionRef: connection.credentialSecretVersionRef ?? undefined,
          encryptedSecretPayload: connection.credentialEncryptedSecretPayload ?? undefined,
        },
      });
      const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
      const appSecret = typeof payload.appSecret === "string" ? payload.appSecret : "";
      if (!appId || !appSecret) {
        throw new CredentialSecretStoreError(
          "Stored Privy credential payload is incomplete",
          "MISSING_SECRET"
        );
      }
      return { appId, appSecret };
    } catch (error) {
      throw new SigningError(
        "Stored Privy credential is unavailable",
        error instanceof CredentialSecretStoreError && error.code === "UPSTREAM_ERROR"
          ? "PROVIDER_UNAVAILABLE"
          : "INTERNAL_ERROR",
        error instanceof Error ? error : undefined
      );
    }
  }

  private async getAdapterForConnection(
    connection: CustodyConnectionRuntimeRecord
  ): Promise<SigningPort> {
    if (!isUsableCustodyConnection(connection)) {
      throw new SigningError("Selected custody Connection is unavailable", "CONFLICT");
    }

    const cacheKey = `connection:${connection.id}:${connection.providerCredentialId}`;
    const cached = this.providerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const credential = await this.readPrivyCredential(connection);
    const adapter = createPrivyAdapterFromCredential(this.env, {
      ...credential,
      defaultWalletId: connection.defaultWalletId,
    });
    this.providerCache.set(cacheKey, adapter);
    return adapter;
  }

  async getConfigurationByProvider(
    orgId: string,
    projectId: string | undefined,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord | null> {
    if (projectId) {
      const scopedConfig = await this.configStore.findActiveByProvider(orgId, projectId, provider);
      if (scopedConfig) {
        return scopedConfig;
      }
    }

    return this.configStore.findActiveByProvider(orgId, undefined, provider);
  }

  async setDefaultConfiguration(
    orgId: string,
    projectId: string | undefined,
    configId: string
  ): Promise<{ walletId: string; publicKey: string } | null> {
    const config = await this.configStore.getById(configId);
    if (!config || config.organizationId !== orgId || config.status !== "active") {
      throw new SigningError("Custody configuration not found", "NOT_FOUND");
    }

    await this.assertProviderEnabled(orgId, config.provider);
    if (this.connectionRuntimeEnabled(projectId)) {
      const wallet = await this.getConnectionStore().selectConfig(orgId, projectId, configId, {
        clearConnection: true,
      });
      this.providerCache.clear();
      return wallet;
    } else {
      await this.configStore.setDefaultConfig(orgId, projectId, configId);
    }
    this.providerCache.clear();
    return null;
  }

  async setDefaultProvider(
    orgId: string,
    projectId: string | undefined,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord> {
    await this.assertProviderEnabled(orgId, provider);

    const scopeConfig = await this.configStore.findActiveByProvider(orgId, projectId, provider);
    if (!scopeConfig) {
      throw new SigningError("Custody not initialized for provider", "NOT_FOUND");
    }

    await this.setDefaultConfiguration(orgId, projectId, scopeConfig.id);
    return scopeConfig;
  }

  private async findExistingProviderWallet(
    orgId: string,
    projectId: string | undefined,
    provider: ReusableSigningProvider
  ): Promise<{ config: SigningConfigRecord; wallet: CustodyWallet } | null> {
    const existingProviderConfig = await this.configStore.findByProvider(
      orgId,
      projectId,
      provider
    );
    if (!existingProviderConfig) {
      return null;
    }

    const wallets = await this.configStore.getWallets(existingProviderConfig.id);
    if (wallets.length === 0) {
      return null;
    }

    const selectedWallet =
      (existingProviderConfig.defaultWalletId
        ? wallets.find((wallet) => wallet.walletId === existingProviderConfig.defaultWalletId)
        : undefined) ?? wallets[0];

    return {
      config: existingProviderConfig,
      wallet: selectedWallet,
    };
  }

  private async findReusableProviderWallet(
    orgId: string,
    projectId: string | undefined,
    provider: ReusableSigningProvider
  ): Promise<{ configId: string; wallet: CustodyWallet } | null> {
    const existingProviderWallet = await this.findExistingProviderWallet(
      orgId,
      projectId,
      provider
    );
    if (!existingProviderWallet) {
      return null;
    }

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider,
      defaultWalletId: existingProviderWallet.wallet.walletId,
    });

    return {
      configId,
      wallet: existingProviderWallet.wallet,
    };
  }

  async getProviderReuseState(
    orgId: string,
    projectId: string | undefined
  ): Promise<ProviderReuseState> {
    const [privy, coinbaseCdp, para, turnkey, utila] = await Promise.all([
      this.findExistingProviderWallet(orgId, projectId, "privy"),
      this.findExistingProviderWallet(orgId, projectId, "coinbase_cdp"),
      this.findExistingProviderWallet(orgId, projectId, "para"),
      this.findExistingProviderWallet(orgId, projectId, "turnkey"),
      this.findExistingProviderWallet(orgId, projectId, "utila"),
    ]);

    return {
      privy: Boolean(privy),
      coinbase_cdp: Boolean(coinbaseCdp),
      para: Boolean(para),
      turnkey: Boolean(turnkey),
      utila: Boolean(utila),
    };
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
    // Check if an active config already exists for this provider.
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "local");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    // Generate a new extractable keypair from a random private key seed.
    const privateKeySeed = crypto.getRandomValues(new Uint8Array(32));
    const keypair = await createKeyPairSignerFromPrivateKeyBytes(privateKeySeed);

    const publicKeyBytes = new Uint8Array(
      (await crypto.subtle.exportKey("raw", keypair.keyPair.publicKey)) as ArrayBuffer
    );
    const privateKeyBytes = new Uint8Array(64);
    privateKeyBytes.set(privateKeySeed);
    privateKeyBytes.set(publicKeyBytes, 32);
    const privateKeyBase58 = base58.decode(privateKeyBytes);

    // Encrypt the private key for storage
    const cipher = this.getCustodyCipher();
    const encryptedKey = await cipher.encrypt(orgId, privateKeyBase58);

    // Create config with encrypted private key
    const configJson: LocalProviderConfig = {
      provider: "local",
      encryptedPrivateKey: encryptedKey,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "local",
      defaultWalletId: keypair.address,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "local");

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
    this.providerCache.delete(configId);

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
    // Check if an active config already exists for this provider.
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "fireblocks");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    // Encrypt the API secret for storage
    const cipher = this.getCustodyCipher();
    const encryptedSecret = await cipher.encrypt(orgId, options.apiSecretPem);

    // Create config with Fireblocks credentials
    const configJson: FireblocksProviderConfig = {
      provider: "fireblocks",
      apiKey: options.apiKey,
      apiSecretEncrypted: encryptedSecret,
      vaultAccountId: options.vaultAccountId,
      assetId: options.assetId ?? "SOL",
    };

    // Create the adapter to get the public key
    const adapter = new KeychainFireblocksAdapter({
      apiKey: options.apiKey,
      apiSecretPem: options.apiSecretPem,
      vaultAccountId: options.vaultAccountId,
      assetId: options.assetId ?? "SOL",
      apiBaseUrl: this.env.FIREBLOCKS_API_BASE_URL,
    });

    const publicKey = await adapter.getPublicKey();
    const walletId = `fb_${options.vaultAccountId}`;

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "fireblocks",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "fireblocks");

    // Update the config with the encrypted JSON
    await this.updateConfigJson(configId, configJson);

    // Create wallet record
    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "Fireblocks Vault",
      purpose: "root",
    });

    // Invalidate cache
    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Initialize signing for an organization with Privy provider.
   *
   * @param orgId - Organization ID
   * @param projectId - Optional project ID for project-specific config
   * @param options - Privy configuration
   * @returns The new config ID, public key, and wallet ID
   */
  async initializePrivySigning(
    orgId: string,
    projectId: string | undefined,
    options: InitPrivySigningOptions
  ): Promise<InitSigningResult> {
    // Check if an active config already exists for this provider.
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "privy");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    const appId = this.env.PRIVY_APP_ID;
    const appSecret = this.env.PRIVY_APP_SECRET;

    // Privy is platform-managed: users never provide app credentials.
    if (!appId || !appSecret) {
      throw new SigningError(
        "Privy environment variables not configured: PRIVY_APP_ID, PRIVY_APP_SECRET",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const configJson: PrivyProviderConfig = {
      provider: "privy",
      requestDelayMs: options.requestDelayMs,
      privyAppId: appId,
    };

    const reusable = await this.findReusableProviderWallet(orgId, projectId, "privy");
    if (reusable) {
      await this.updateConfigJson(reusable.configId, configJson);
      await this.ensureScopeDefaultConfigForExistingRecord(orgId, projectId, reusable.configId);
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    // Provision a new Privy server wallet under the platform app.
    const provisioned = await custodyProvisioning.provisionPrivyWallet(this.env, {});
    const publicKey = provisioned.address as Address;
    const walletId = normalizePrivyWalletId(provisioned.walletId);

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "privy",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "privy");

    // Update the config with the encrypted JSON
    await this.updateConfigJson(configId, configJson);

    // Create wallet record
    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "Default",
      purpose: "root",
    });

    // Invalidate cache
    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Initialize signing for an organization with Coinbase CDP provider.
   */
  async initializeCoinbaseCdpSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitCoinbaseCdpSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "coinbase_cdp");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    if (
      !this.env.COINBASE_CDP_API_KEY_ID ||
      !this.env.COINBASE_CDP_API_KEY_SECRET ||
      !this.env.COINBASE_CDP_WALLET_SECRET
    ) {
      throw new SigningError(
        "Coinbase CDP environment variables not configured: COINBASE_CDP_API_KEY_ID, COINBASE_CDP_API_KEY_SECRET, COINBASE_CDP_WALLET_SECRET",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const reusable = await this.findReusableProviderWallet(orgId, projectId, "coinbase_cdp");

    if (reusable) {
      const configJson: CoinbaseCdpProviderConfig = {
        provider: "coinbase_cdp",
        network: options.network ?? this.env.COINBASE_CDP_NETWORK,
        accountPolicy: options.accountPolicy,
      };

      await this.updateConfigJson(reusable.configId, configJson);
      await this.ensureScopeDefaultConfigForExistingRecord(orgId, projectId, reusable.configId);
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await custodyProvisioning.provisionCoinbaseCdpAccount(this.env, {
      orgId,
      orgSlug: orgId,
      network: options.network,
      accountPolicy: options.accountPolicy,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeCoinbaseCdpWalletId(provisioned.address);

    const configJson: CoinbaseCdpProviderConfig = {
      provider: "coinbase_cdp",
      network: provisioned.network,
      accountPolicy: options.accountPolicy,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "coinbase_cdp",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "coinbase_cdp");

    await this.updateConfigJson(configId, configJson);

    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "CDP Root Wallet",
      purpose: "root",
    });

    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Initialize signing for an organization with Para provider.
   *
   * Para credentials are platform-managed and wallets are provisioned per
   * organization/project scope.
   */
  async initializeParaSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitParaSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "para");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    if (!this.env.PARA_API_KEY) {
      throw new SigningError(
        "Para environment variables not configured: PARA_API_KEY",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const reusable = await this.findReusableProviderWallet(orgId, projectId, "para");

    if (reusable) {
      const configJson: ParaProviderConfig = {
        provider: "para",
        requestDelayMs: options.requestDelayMs,
      };

      await this.updateConfigJson(reusable.configId, configJson);
      await this.ensureScopeDefaultConfigForExistingRecord(orgId, projectId, reusable.configId);
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await custodyProvisioning.provisionParaWallet(this.env, {
      orgId,
      projectId,
      orgSlug: orgId,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeParaWalletId(provisioned.walletId);

    const configJson: ParaProviderConfig = {
      provider: "para",
      requestDelayMs: options.requestDelayMs,
      walletId: provisioned.walletId,
      userIdentifier: provisioned.userIdentifier,
      userIdentifierType: provisioned.userIdentifierType,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "para",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "para");

    await this.updateConfigJson(configId, configJson);

    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "Para Root Wallet",
      purpose: "root",
    });

    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Initialize signing for an organization with Turnkey provider.
   *
   * Turnkey credentials are platform-managed and wallets are provisioned per
   * organization/project scope.
   */
  async initializeTurnkeySigning(
    orgId: string,
    projectId: string | undefined,
    options: InitTurnkeySigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "turnkey");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    if (
      !this.env.TURNKEY_API_PUBLIC_KEY ||
      !this.env.TURNKEY_API_PRIVATE_KEY ||
      !this.env.TURNKEY_ORGANIZATION_ID
    ) {
      throw new SigningError(
        "Turnkey environment variables not configured: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const reusable = await this.findReusableProviderWallet(orgId, projectId, "turnkey");

    if (reusable) {
      const reusablePublicKey = reusable.wallet.publicKey as Address;
      const configJson: TurnkeyProviderConfig = {
        provider: "turnkey",
        organizationId: this.env.TURNKEY_ORGANIZATION_ID,
        requestDelayMs: options.requestDelayMs,
        defaultWalletPublicKey: reusablePublicKey,
      };

      await this.updateConfigJson(reusable.configId, configJson);
      await this.ensureScopeDefaultConfigForExistingRecord(orgId, projectId, reusable.configId);
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusablePublicKey,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await custodyProvisioning.provisionTurnkeyPrivateKey(this.env, {
      orgId,
      orgSlug: orgId,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeTurnkeyWalletId(provisioned.privateKeyId);

    const configJson: TurnkeyProviderConfig = {
      provider: "turnkey",
      organizationId: this.env.TURNKEY_ORGANIZATION_ID,
      requestDelayMs: options.requestDelayMs,
      defaultWalletPublicKey: publicKey,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "turnkey",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "turnkey");

    await this.updateConfigJson(configId, configJson);

    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "Turnkey Root Wallet",
      purpose: "root",
    });

    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Initialize signing for an organization with DFNS provider.
   *
   * DFNS credentials are platform-managed via env bindings.
   */
  async initializeDfnsSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitDfnsSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "dfns");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    const client = await createDfnsApiClient(this.env);
    const resolvedNetwork = resolveDfnsNetwork(options.network);

    const wallet = await client.wallets.createWallet({
      body: {
        network: resolvedNetwork,
        ...(options.walletLabel ? { name: options.walletLabel } : {}),
      },
    });

    if (!wallet?.id || !wallet?.address) {
      throw new SigningError(
        "DFNS wallet provisioning failed: API returned incomplete wallet payload",
        "NETWORK_ERROR"
      );
    }

    const walletId = normalizeDfnsWalletId(wallet.id);
    const publicKey = wallet.address as Address;
    const walletNetwork =
      wallet.network === "Solana" || wallet.network === "SolanaDevnet"
        ? wallet.network
        : resolvedNetwork;

    const configJson: DfnsProviderConfig = {
      provider: "dfns",
      network: walletNetwork,
      walletId: wallet.id,
      signingKeyId: wallet.signingKey?.id,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "dfns",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "dfns");
    await this.updateConfigJson(configId, configJson);

    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "DFNS Root Wallet",
      purpose: "root",
    });

    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Initialize signing for an organization with IBM Digital Asset Haven.
   *
   * IBM Digital Asset Haven is a white-label Dfns deployment, so this reuses the
   * Dfns wallet API with IBM-hosted credentials (IBM_HAVEN_* env bindings).
   */
  async initializeIbmHavenSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitIbmHavenSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "ibm_haven");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    const client = await createIbmHavenApiClient(this.env);
    const resolvedNetwork = resolveDfnsNetwork(options.network, IBM_HAVEN_PROVIDER_LABEL);

    const wallet = await client.wallets.createWallet({
      body: {
        network: resolvedNetwork,
        ...(options.walletLabel ? { name: options.walletLabel } : {}),
      },
    });

    if (!wallet?.id || !wallet?.address) {
      throw new SigningError(
        "IBM Digital Asset Haven wallet provisioning failed: API returned incomplete wallet payload",
        "NETWORK_ERROR"
      );
    }

    const walletId = normalizeIbmHavenWalletId(wallet.id);
    const publicKey = wallet.address as Address;
    const walletNetwork =
      wallet.network === "Solana" || wallet.network === "SolanaDevnet"
        ? wallet.network
        : resolvedNetwork;

    const configJson: IbmHavenProviderConfig = {
      provider: "ibm_haven",
      network: walletNetwork,
      walletId: wallet.id,
      signingKeyId: wallet.signingKey?.id,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "ibm_haven",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "ibm_haven");
    await this.updateConfigJson(configId, configJson);

    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "IBM Digital Asset Haven Root Wallet",
      purpose: "root",
    });

    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * Initialize wallet lifecycle for an organization with Anchorage provider.
   *
   * Anchorage does not currently support transaction signing in SDP.
   */
  async initializeAnchorageWalletLifecycle(
    orgId: string,
    projectId: string | undefined,
    options: InitAnchorageSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "anchorage");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    const provisioned = await custodyProvisioning.provisionAnchorageWallet(this.env, {
      walletLabel: options.walletLabel,
      network: options.network,
    });

    const walletId = normalizeAnchorageWalletId(provisioned.walletId);
    const publicKey = provisioned.address as Address;
    const configJson: AnchorageProviderConfig = {
      provider: "anchorage",
      walletId: provisioned.walletId,
      network: options.network,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "anchorage",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "anchorage");
    await this.updateConfigJson(configId, configJson);

    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "Anchorage Wallet",
      purpose: "root",
    });

    this.providerCache.delete(configId);

    return {
      configId,
      publicKey,
      walletId,
    };
  }

  /**
   * @deprecated Use initializeAnchorageWalletLifecycle.
   */
  async initializeAnchorageSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitAnchorageSigningOptions
  ): Promise<InitSigningResult> {
    return this.initializeAnchorageWalletLifecycle(orgId, projectId, options);
  }

  /**
   * Initialize signing for an organization with Utila provider.
   *
   * Utila is platform-managed: SDP creates a new Solana sub-wallet inside the
   * configured vault and stores it like the other hosted providers.
   */
  async initializeUtilaSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitUtilaSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "utila");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    if (
      !this.env.UTILA_SERVICE_ACCOUNT_EMAIL ||
      !this.env.UTILA_SERVICE_ACCOUNT_PRIVATE_KEY ||
      !this.env.UTILA_VAULT_ID
    ) {
      throw new SigningError(
        "Utila environment variables not configured: UTILA_SERVICE_ACCOUNT_EMAIL, UTILA_SERVICE_ACCOUNT_PRIVATE_KEY, UTILA_VAULT_ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const reusable = await this.findReusableProviderWallet(orgId, projectId, "utila");
    if (reusable) {
      const configJson: UtilaProviderConfig = {
        provider: "utila",
        vaultId: this.env.UTILA_VAULT_ID,
        network: this.env.UTILA_NETWORK,
      };

      await this.updateConfigJson(reusable.configId, configJson);
      await this.ensureScopeDefaultConfigForExistingRecord(orgId, projectId, reusable.configId);
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await custodyProvisioning.provisionUtilaWallet(this.env, {
      displayName: options.walletLabel,
    });

    const walletId = normalizeUtilaWalletId(provisioned.walletId);
    const publicKey = provisioned.address as Address;
    const configJson: UtilaProviderConfig = {
      provider: "utila",
      vaultId: provisioned.vaultId,
      network: provisioned.network,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "utila",
      defaultWalletId: walletId,
    });
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, "utila");
    await this.updateConfigJson(configId, configJson);

    await this.configStore.createWallet(configId, {
      walletId,
      publicKey,
      label: options.walletLabel ?? "Utila Wallet",
      purpose: "root",
    });

    this.providerCache.delete(configId);

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
    if (this.connectionRuntimeEnabled(projectId)) {
      const selectedConnection = await this.getConnectionStore().getSelectedProjectConnection(
        orgId,
        projectId
      );
      if (selectedConnection) {
        if (!isUsableCustodyConnection(selectedConnection)) {
          throw new SigningError("Selected custody Connection is unavailable", "CONFLICT");
        }
        return this.getConnectionStore().listConnectionWallets(
          orgId,
          projectId,
          selectedConnection.id
        );
      }
    }

    const config = await this.configStore.findActive(orgId, projectId);
    if (!config) {
      return [];
    }
    return this.configStore.getWallets(config.id);
  }

  async getWalletsWithProviders(
    orgId: string,
    projectId: string | undefined,
    options?: ListWalletsOptions
  ): Promise<CustodyWalletWithProvider[]> {
    const includeAllProviders = options?.includeAllProviders === true;
    const providerFilter = options?.provider;
    const selectedConnection = this.connectionRuntimeEnabled(projectId)
      ? await this.getConnectionStore().getSelectedProjectConnection(orgId, projectId)
      : null;
    const resolvedDefaultConfig = selectedConnection
      ? null
      : await this.configStore.findActive(orgId, projectId);
    const defaultConfigId = resolvedDefaultConfig?.id ?? null;

    const configs = includeAllProviders
      ? (await this.getScopeAndFallbackConfigs(orgId, projectId)).filter((config) =>
          providerFilter ? config.provider === providerFilter : true
        )
      : [
          providerFilter
            ? await this.getConfigurationByProvider(orgId, projectId, providerFilter)
            : resolvedDefaultConfig,
        ].filter((config): config is SigningConfigRecord => Boolean(config));

    const walletsByConfigId =
      configs.length === 0
        ? new Map<string, CustodyWallet[]>()
        : await this.configStore.getWalletsForConfigs(configs.map((config) => config.id));

    const configWallets = configs.flatMap((config) =>
      (walletsByConfigId.get(config.id) ?? []).map((wallet) => ({
        ...wallet,
        provider: config.provider,
        isDefaultProvider: defaultConfigId === config.id,
      }))
    );

    if (
      !this.connectionRuntimeEnabled(projectId) ||
      (providerFilter && providerFilter !== "privy")
    ) {
      return configWallets;
    }

    const connectionWallets = includeAllProviders
      ? await this.getConnectionStore().listConnectionWallets(orgId, projectId)
      : selectedConnection
        ? await this.getConnectionStore().listConnectionWallets(
            orgId,
            projectId,
            selectedConnection.id
          )
        : [];

    return [
      ...configWallets,
      ...connectionWallets.map(({ connectionId, ...wallet }) => ({
        ...wallet,
        provider: "privy" as const,
        isDefaultProvider: selectedConnection !== null && selectedConnection.id === connectionId,
      })),
    ];
  }

  async getWalletById(
    orgId: string,
    projectId: string | undefined,
    walletId: string
  ): Promise<CustodyWalletWithProvider | null> {
    const owner = await this.getConnectionStore().findWalletOwner(orgId, projectId, walletId);
    return this.mapUsableWalletOwner(owner);
  }

  async getWalletByPublicKey(
    orgId: string,
    projectId: string | undefined,
    publicKey: string
  ): Promise<CustodyWalletWithProvider | null> {
    const owner = await this.getConnectionStore().findWalletOwnerByPublicKey(
      orgId,
      projectId,
      publicKey
    );
    return this.mapUsableWalletOwner(owner);
  }

  async setDefaultWallet(
    orgId: string,
    projectId: string | undefined,
    walletId: string,
    provider?: SigningConfiguration["provider"]
  ): Promise<CustodyWalletWithProvider> {
    const owner = await this.getConnectionStore().findWalletOwner(orgId, projectId, walletId);
    if (
      owner?.ownerStatus !== "active" ||
      (owner.kind === "connection" && !this.connectionProviderEnabled(owner.provider))
    ) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
    if (provider !== undefined && owner.provider !== provider) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }

    if (owner.kind === "connection") {
      if (!isUsableCustodyConnection(owner.connection)) {
        throw new SigningError("Custody Connection is not usable", "CONFLICT");
      }
      await this.getConnectionStore().setDefaultWallet(
        orgId,
        owner.projectId,
        owner.ownerId,
        owner.wallet.id
      );
      this.providerCache.delete(
        `connection:${owner.ownerId}:${owner.connection.providerCredentialId}`
      );
    } else {
      await this.assertProviderEnabled(orgId, owner.provider as SigningConfiguration["provider"]);
      await getDb(this.env)
        .prepare(
          `UPDATE custody_configs
           SET default_wallet_id = ?, updated_at = sdp_iso_now()
           WHERE id = ?`
        )
        .bind(owner.wallet.walletId, owner.custodyConfigId)
        .run();
      this.providerCache.delete(owner.custodyConfigId);
    }

    return this.mapWalletOwner(owner);
  }

  async switchCustodyTarget(
    orgId: string,
    projectId: string | undefined,
    params: {
      provider: SigningConfiguration["provider"];
      walletLabel?: string;
      requestId?: string;
    }
  ): Promise<ConnectionTargetSwitchResult | null> {
    if (!this.connectionRuntimeEnabled(projectId) || params.provider !== "privy") {
      return null;
    }

    const target = await this.classifyPrivyConnection(orgId, projectId);
    if (target.kind === "absent") {
      return null;
    }
    if (target.kind === "pending") {
      return {
        kind: "connection",
        connectionId: target.connection.id,
        wallet: await this.createPrivyConnectionWallet(target.connection, {
          label: params.walletLabel,
          requestId: params.requestId,
        }),
      };
    }

    return {
      kind: "connection",
      connectionId: target.connection.id,
      wallet: await this.getConnectionStore().selectConnection(
        orgId,
        projectId,
        target.connection.id
      ),
    };
  }

  async getSelectedConnectionProjection(
    orgId: string,
    projectId: string | undefined
  ): Promise<{ provider: "privy"; usable: boolean } | null> {
    if (!this.connectionRuntimeEnabled(projectId)) {
      return null;
    }
    const connection = await this.getConnectionStore().getSelectedProjectConnection(
      orgId,
      projectId
    );
    return connection
      ? { provider: connection.provider, usable: isUsableCustodyConnection(connection) }
      : null;
  }

  private async resolvePrivyConnectionCreateTarget(
    orgId: string,
    projectId: string | undefined,
    requestedProvider: SigningConfiguration["provider"] | undefined
  ): Promise<CustodyConnectionRuntimeRecord | null> {
    if (!this.connectionRuntimeEnabled(projectId)) {
      return null;
    }

    let provider = requestedProvider;
    let target: PrivyConnectionClassification | null = null;
    if (!provider) {
      const selectedConnection = await this.getConnectionStore().getSelectedProjectConnection(
        orgId,
        projectId
      );
      provider = selectedConnection?.provider;
      if (!provider) {
        provider = (await this.configStore.findActive(orgId, projectId))?.provider;
      }
      if (!provider) {
        target = await this.classifyPrivyConnection(orgId, projectId);
        if (target.kind === "active") {
          throw new SigningError("No custody target is selected", "CONFLICT");
        }
      }
    }

    if (provider !== "privy" && target?.kind !== "pending") {
      return null;
    }
    target ??= await this.classifyPrivyConnection(orgId, projectId);
    return target.kind === "absent" ? null : target.connection;
  }

  /**
   * Provision a new wallet in custody for the resolved provider configuration.
   *
   * Providers that support wallet lifecycle are controlled by provider capability flags.
   */
  async createWallet(
    orgId: string,
    projectId: string | undefined,
    params: {
      label?: string;
      purpose?: WalletPurpose;
      setDefault?: boolean;
      provider?: SigningConfiguration["provider"];
      requestId?: string;
    }
  ): Promise<CustodyWallet> {
    const connection = await this.resolvePrivyConnectionCreateTarget(
      orgId,
      projectId,
      params.provider
    );
    if (connection) {
      return this.createPrivyConnectionWallet(connection, params);
    }

    const config = params.provider
      ? await this.getConfigurationByProvider(orgId, projectId, params.provider)
      : await this.configStore.findActive(orgId, projectId);
    if (!config) {
      throw new SigningError(
        params.provider
          ? `Custody not initialized for provider: ${params.provider}`
          : "Custody not initialized",
        "NOT_FOUND"
      );
    }

    await this.assertProviderEnabled(orgId, config.provider);
    assertCustodyProviderCanCreateWallet(config.provider);

    const parsed = await parseConfigRecord(this.env, orgId, config, this.getCustodyCipher());
    const { walletId, publicKey } = await createProviderWallet({
      env: this.env,
      orgId,
      projectId,
      params: {
        label: params.label,
      },
      parsed,
      cipher: this.getCustodyCipher(),
    });

    let wallet: CustodyWallet;
    try {
      wallet = await this.configStore.createWallet(config.id, {
        walletId,
        publicKey,
        label: params.label,
        purpose: params.purpose,
      });
    } catch (error) {
      throw new SigningError(
        `Failed to persist wallet record: ${error instanceof Error ? error.message : "Unknown error"}`,
        "NETWORK_ERROR",
        error instanceof Error ? error : undefined
      );
    }

    if (params.setDefault) {
      try {
        await getDb(this.env)
          .prepare(
            `UPDATE custody_configs SET default_wallet_id = ?, updated_at = datetime('now') WHERE id = ?`
          )
          .bind(walletId, config.id)
          .run();
      } catch (error) {
        throw new SigningError(
          `Failed to update default wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
          "NETWORK_ERROR",
          error instanceof Error ? error : undefined
        );
      }

      this.providerCache.delete(config.id);
    }

    return wallet;
  }

  private async createPrivyConnectionWallet(
    connection: CustodyConnectionRuntimeRecord,
    params: {
      label?: string;
      purpose?: WalletPurpose;
      setDefault?: boolean;
      requestId?: string;
    }
  ): Promise<CustodyWallet> {
    await this.assertPrivyConnectionWalletCreationEntitled(connection.organizationId);
    const credential = await this.readPrivyCredential(connection);

    let provisioned: custodyProvisioning.ProvisionPrivyResult;
    try {
      provisioned = await custodyProvisioning.provisionPrivyWallet(this.env, {}, credential);
    } catch (error) {
      if (error instanceof SigningError && error.code === "NETWORK_ERROR") {
        logWalletOrphanRisk(connection, {
          requestId: params.requestId,
          reason: "wallet_create_outcome_unknown",
        });
      }
      throw new SigningError(
        "Privy wallet provider is unavailable",
        "PROVIDER_UNAVAILABLE",
        error instanceof Error ? error : undefined
      );
    }

    try {
      const persisted = await this.getConnectionStore().persistCreatedWallet({
        organizationId: connection.organizationId,
        projectId: connection.projectId,
        connectionId: connection.id,
        providerCredentialId: connection.providerCredentialId,
        walletId: normalizePrivyWalletId(provisioned.walletId),
        publicKey: provisioned.address,
        label: params.label,
        purpose: params.purpose,
        setDefault: params.setDefault === true,
      });
      this.providerCache.delete(`connection:${connection.id}:${connection.providerCredentialId}`);
      return persisted.wallet;
    } catch (error) {
      logWalletOrphanRisk(connection, {
        requestId: params.requestId,
        providerWalletId: provisioned.walletId,
        reason: "wallet_persist_failed",
      });
      if (error instanceof SigningError && error.code === "CONFLICT") {
        throw error;
      }
      throw new SigningError(
        "Privy wallet was created but could not be persisted",
        "INTERNAL_ERROR",
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * Delete a wallet from the resolved provider configuration.
   *
   * Deletion support is provider-dependent. Providers without delete capability
   * will return INVALID_REQUEST.
   */
  async deleteWallet(
    orgId: string,
    projectId: string | undefined,
    params: {
      walletId: string;
      provider?: SigningConfiguration["provider"];
    }
  ): Promise<void> {
    const config = params.provider
      ? await this.getConfigurationByProvider(orgId, projectId, params.provider)
      : await this.configStore.findActive(orgId, projectId);
    if (!config) {
      throw new SigningError(
        params.provider
          ? `Custody not initialized for provider: ${params.provider}`
          : "Custody not initialized",
        "NOT_FOUND"
      );
    }

    await this.assertProviderEnabled(orgId, config.provider);
    assertCustodyProviderCanDeleteWallet(config.provider);

    const wallets = await this.configStore.getWallets(config.id);
    const targetWallet = wallets.find((wallet) => wallet.walletId === params.walletId);
    if (!targetWallet) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }

    const parsed = await parseConfigRecord(this.env, orgId, config, this.getCustodyCipher());
    const deactivateResult = await this.configStore.deactivateWalletIfNotLast(
      config.id,
      targetWallet.walletId
    );
    if (deactivateResult === "wallet_not_found") {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
    if (deactivateResult === "last_wallet") {
      throw new SigningError(
        "Cannot delete the last wallet for an active custody provider",
        "INVALID_REQUEST"
      );
    }

    try {
      await deleteProviderWallet({
        env: this.env,
        walletId: targetWallet.walletId,
        parsed,
      });
    } catch (error) {
      await this.configStore.reactivateWallet(config.id, targetWallet.walletId);
      if (error instanceof SigningError) {
        throw error;
      }
      throw error;
    }

    if (config.defaultWalletId === targetWallet.walletId) {
      const remainingWallets = await this.configStore.getWallets(config.id);
      const nextDefaultWalletId = remainingWallets[0]?.walletId ?? null;

      await getDb(this.env)
        .prepare(
          `UPDATE custody_configs
         SET default_wallet_id = ?, updated_at = datetime('now')
         WHERE id = ?`
        )
        .bind(nextDefaultWalletId, config.id)
        .run();

      this.providerCache.delete(config.id);
    }
  }

  /**
   * Update the encrypted config JSON for a custody config.
   * This is a private helper - the public API uses initializeLocalSigning/initializeFireblocksSigning/initializePrivySigning.
   */
  private async updateConfigJson(
    configId: string,
    config:
      | LocalProviderConfig
      | FireblocksProviderConfig
      | PrivyProviderConfig
      | CoinbaseCdpProviderConfig
      | ParaProviderConfig
      | TurnkeyProviderConfig
      | DfnsProviderConfig
      | IbmHavenProviderConfig
      | AnchorageProviderConfig
      | UtilaProviderConfig
  ): Promise<void> {
    // This would normally be a direct DB update, but we'll use the upsert pattern
    // The config JSON is stored in the `config_encrypted` column of custody_configs
    const configStore = this.configStore as CustodyConfigStore;
    const existing = await configStore.getById(configId);
    if (!existing) {
      throw new SigningError("Config not found", "NOT_FOUND");
    }

    // Direct database update for the config JSON
    // This is safe because we're only updating our own config
    const db = getDb(this.env);
    const cipher = this.getCustodyCipher();
    const encryptedConfig = await cipher.encrypt(existing.organizationId, JSON.stringify(config));
    const encryptionVersion = encryptedConfig.startsWith("v2.")
      ? "sdp-custody-kms-v2"
      : "sdp-custody-encryption-v1";
    await db
      .prepare(
        "UPDATE custody_configs SET config_encrypted = ?, encryption_version = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(encryptedConfig, encryptionVersion, configId)
      .run();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the signing adapter for an organization/project.
   *
   * Resolution order:
   * 1. Scope default config (project scope if projectId provided)
   * 2. Organization default config (fallback for project scope)
   */
  async getAdapter(orgId: string, projectId?: string): Promise<SigningPort> {
    if (this.connectionRuntimeEnabled(projectId)) {
      const connection = await this.getConnectionStore().getSelectedProjectConnection(
        orgId,
        projectId
      );
      if (connection) {
        return this.getAdapterForConnection(connection);
      }
    }

    const config = await this.configStore.findActive(orgId, projectId);
    return this.getAdapterForConfig(orgId, config);
  }

  private async getAdapterForConfig(
    orgId: string,
    config: SigningConfigRecord | null
  ): Promise<SigningPort> {
    if (!config) {
      throw new SigningError("Custody not initialized", "NOT_FOUND");
    }

    await this.assertProviderEnabled(orgId, config.provider);

    const cacheKey = config.id;

    const cached = this.providerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const adapter = await createAdapterFromEncryptedConfig(
      this.env,
      orgId,
      config,
      this.getCustodyCipher()
    );

    this.providerCache.set(cacheKey, adapter);
    return adapter;
  }

  private async resolveAdapterForRequest(
    orgId: string,
    projectId: string | undefined,
    walletId?: string | null
  ): Promise<{ adapter: SigningPort; walletId?: string; walletPublicKey?: Address }> {
    if (!walletId) {
      return { adapter: await this.getAdapter(orgId, projectId) };
    }

    const owner = await this.getConnectionStore().findWalletOwner(orgId, projectId, walletId);
    if (
      owner?.ownerStatus !== "active" ||
      (owner.kind === "connection" && !this.connectionProviderEnabled(owner.provider))
    ) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }

    let adapter: SigningPort;
    if (owner.kind === "connection") {
      adapter = await this.getAdapterForConnection(owner.connection);
    } else {
      const config = await this.configStore.getById(owner.custodyConfigId);
      if (!config || config.organizationId !== orgId || config.status !== "active") {
        throw new SigningError("Custody configuration not found", "WALLET_NOT_FOUND");
      }
      adapter = await this.getAdapterForConfig(orgId, config);
    }

    return {
      adapter,
      walletId: owner.wallet.walletId,
      walletPublicKey: owner.wallet.publicKey as Address,
    };
  }

  /**
   * Get the public key for the signing wallet.
   */
  async getPublicKey(orgId: string, projectId?: string, walletId?: string): Promise<Address> {
    if (!walletId) {
      if (this.connectionRuntimeEnabled(projectId)) {
        const connection = await this.getConnectionStore().getSelectedProjectConnection(
          orgId,
          projectId
        );
        if (connection) {
          if (!isUsableCustodyConnection(connection) || !connection.defaultWalletPublicKey) {
            throw new SigningError("Selected custody Connection is unavailable", "CONFLICT");
          }
          return connection.defaultWalletPublicKey as Address;
        }
      }

      const config = await this.configStore.findActive(orgId, projectId);
      if (!config) {
        throw new SigningError("Custody not initialized", "NOT_FOUND");
      }

      const wallets = await this.configStore.getWallets(config.id);
      const defaultWallet =
        (config.defaultWalletId
          ? wallets.find((wallet) => wallet.walletId === config.defaultWalletId)
          : undefined) ?? wallets[0];

      if (defaultWallet) {
        return defaultWallet.publicKey as Address;
      }
    }

    const resolved = await this.resolveAdapterForRequest(orgId, projectId, walletId);
    if (resolved.walletPublicKey) {
      return resolved.walletPublicKey;
    }
    return resolved.adapter.getPublicKey(resolved.walletId);
  }

  /**
   * Get a KeyPairSigner for backward compatibility.
   * Only works with KeychainMemoryAdapter.
   */
  async getKeypairSigner(orgId: string, projectId?: string): Promise<KeyPairSigner> {
    const adapter = await this.getAdapter(orgId, projectId);

    if (adapter instanceof KeychainMemoryAdapter) {
      return adapter.getKeypairSigner();
    }

    throw new SigningError(
      `KeyPairSigner not available for provider type: ${adapter.providerId}. Use getTransactionSigner() instead.`,
      "INVALID_REQUEST"
    );
  }

  /**
   * Get a transaction signer compatible with @solana/kit.
   * Works with KeychainMemoryAdapter, KeychainFireblocksAdapter, KeychainPrivyAdapter,
   * KeychainCoinbaseAdapter, KeychainParaAdapter, KeychainTurnkeyAdapter, and KeychainDfnsAdapter.
   *
   * Returns a TransactionSigner that can be used with:
   * - signTransactionMessageWithSigners()
   * - partiallySignTransactionMessageWithSigners()
   * - addSignersToTransactionMessage()
   */
  async getTransactionSigner(
    orgId: string,
    projectId?: string,
    walletId?: string | null
  ): Promise<TransactionSigner> {
    const resolved = await this.resolveAdapterForRequest(orgId, projectId, walletId);
    const adapter = resolved.adapter;

    if (!isFullSigningPort(adapter)) {
      throw new SigningError(
        `Provider does not support transaction signing: ${adapter.providerId}`,
        "INVALID_REQUEST"
      );
    }

    return adapter.getTransactionSigner(resolved.walletId, resolved.walletPublicKey);
  }

  private mapWalletOwner(owner: CustodyWalletOwner): CustodyWalletWithProvider {
    return {
      ...owner.wallet,
      ...(owner.kind === "config" ? { custodyConfigId: owner.custodyConfigId } : {}),
      provider: owner.provider as SigningConfiguration["provider"],
      isDefaultProvider: owner.isSelected,
    };
  }

  private mapUsableWalletOwner(owner: CustodyWalletOwner | null): CustodyWalletWithProvider | null {
    if (
      owner?.ownerStatus !== "active" ||
      (owner.kind === "connection" &&
        (!this.connectionProviderEnabled(owner.provider) ||
          !isUsableCustodyConnection(owner.connection)))
    ) {
      return null;
    }
    return this.mapWalletOwner(owner);
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
    if (this.connectionRuntimeEnabled(projectId)) {
      const connection = await this.getConnectionStore().getSelectedProjectConnection(
        orgId,
        projectId
      );
      if (connection) {
        assertCustodyProviderCanSign(connection.provider);
        return (await this.getAdapterForConnection(connection)).sign(request);
      }
    }

    const config = await this.configStore.findActive(orgId, projectId);
    if (!config) {
      throw new SigningError("Custody not initialized", "NOT_FOUND");
    }

    assertCustodyProviderCanSign(config.provider);

    const adapter = await this.getAdapterForConfig(orgId, config);
    const result = await adapter.sign(request);

    // Track async signing requests
    if (result.status === "pending" && result.requestId) {
      await this.signingStore.create({
        organizationId: orgId,
        custodyConfigId: config.id,
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
      const signaturesJson = parsePostgresJson<
        Array<{
          publicKey: string;
          signature: string;
        }>
      >(record.signatures);
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
    const config = await this.configStore.getById(record.custodyConfigId);
    if (!config) {
      return { status: "failed", error: "Custody configuration not found" };
    }

    // Use encrypted config handler to properly decrypt credentials
    const adapter = await createAdapterFromEncryptedConfig(
      this.env,
      record.organizationId,
      config,
      this.getCustodyCipher()
    );

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
    const configId = await this.configStore.upsert(orgId, projectId, config);
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, config.provider);

    // Invalidate cache for this config.
    this.providerCache.delete(configId);
  }

  /**
   * Get the current signing configuration.
   */
  async getConfiguration(orgId: string, projectId?: string): Promise<SigningConfigRecord | null> {
    if (
      this.connectionRuntimeEnabled(projectId) &&
      (await this.getConnectionStore().getSelectedProjectConnection(orgId, projectId))
    ) {
      return null;
    }
    return this.configStore.findActive(orgId, projectId);
  }

  async getConfigurations(orgId: string, projectId?: string): Promise<SigningConfigurationsResult> {
    const selectedConnectionPromise = this.connectionRuntimeEnabled(projectId)
      ? this.getConnectionStore().getSelectedProjectConnection(orgId, projectId)
      : Promise.resolve(null);
    const [configs, resolvedDefault, selectedConnection] = await Promise.all([
      this.getScopeAndFallbackConfigs(orgId, projectId),
      this.configStore.findActive(orgId, projectId),
      selectedConnectionPromise,
    ]);

    return {
      configs,
      defaultConfigId: selectedConnection ? null : (resolvedDefault?.id ?? null),
    };
  }

  /**
   * Check if the current provider requires async approval.
   */
  async requiresApproval(orgId: string, projectId?: string): Promise<boolean> {
    if (this.connectionRuntimeEnabled(projectId)) {
      const connection = await this.getConnectionStore().getSelectedProjectConnection(
        orgId,
        projectId
      );
      if (connection) {
        return (await this.getAdapterForConnection(connection)).requiresApproval();
      }
    }

    const config = await this.configStore.findActive(orgId, projectId);
    if (!config) {
      throw new SigningError("Custody not initialized", "NOT_FOUND");
    }

    if (!custodyProviderCanSign(config.provider)) {
      return false;
    }

    const adapter = await this.getAdapterForConfig(orgId, config);
    return adapter.requiresApproval();
  }

  /**
   * Invalidate cached adapter for an org/project.
   * Call this after key rotation or config updates to force re-resolution.
   */
  invalidateCache(orgId: string, projectId?: string): void {
    // Cache keys are config IDs; resolving the current one would require I/O.
    // Clearing the in-memory cache is safe and keeps the API behavior correct.
    void orgId;
    void projectId;
    this.providerCache.clear();
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

function logWalletOrphanRisk(
  connection: CustodyConnectionRuntimeRecord,
  params: {
    requestId?: string;
    providerWalletId?: string;
    reason: "wallet_create_outcome_unknown" | "wallet_persist_failed";
  }
): void {
  console.error("custody_wallet_orphan_risk", {
    connectionId: connection.id,
    provider: connection.provider,
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(params.providerWalletId ? { providerWalletId: params.providerWalletId } : {}),
    reason: params.reason,
  });
}

/**
 * Export the secret key bytes from a KeyPairSigner.
 * Returns the 64-byte secret key (32 private + 32 public).
 */

// ═══════════════════════════════════════════════════════════════════════════
// Factory Function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a SigningService instance from environment bindings.
 *
 * This factory wires up the Postgres-backed stores and creates a fully
 * functional SigningService ready for use in request handlers.
 *
 * @param env - API process environment
 * @returns Configured SigningService instance
 */
export function createSigningService(env: Env): SigningService {
  const db = getDb(env);
  const configStore = new CustodyConfigStore(db, env);
  const signingStore = new SigningRequestStorePg(db);
  const connectionStore = new CustodyConnectionRuntimeStore(
    db,
    enabledCustodyConnectionProviders(env)
  );

  return new SigningService(configStore, signingStore, env, connectionStore);
}
