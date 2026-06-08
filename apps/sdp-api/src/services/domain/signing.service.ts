/**
 * Signing Service
 *
 * Domain service for managing signing operations and provider resolution.
 * Handles DB-backed config resolution (project default → org default) and async signing flows.
 */

import { getBase58Codec } from "@solana/codecs";
import type { Address, KeyPairSigner, TransactionSigner } from "@solana/kit";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/signers";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import {
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  type SigningConfigRecord,
} from "@/services/adapters";
import type { CustodyProvider } from "@/services/custody/providers";
import * as custodyProvisioning from "@/services/custody/provisioning";
import {
  assertCustodyProviderCanCreateWallet,
  assertCustodyProviderCanDeleteWallet,
  assertCustodyProviderCanSign,
  custodyProviderCanSign,
  shouldSetCustodyScopeDefault,
} from "@/services/custody-provider-lifecycle.service";
import {
  createDfnsApiClient,
  normalizeDfnsWalletId,
  resolveDfnsNetwork,
} from "@/services/dfns/client";
import { createAdapterFromEncryptedConfig } from "@/services/domain/signing/provider-adapter-factory";
import {
  type AnchorageProviderConfig,
  type CoinbaseCdpProviderConfig,
  type DfnsProviderConfig,
  type FireblocksProviderConfig,
  type LocalProviderConfig,
  type ParaProviderConfig,
  type PrivyProviderConfig,
  parseConfigRecord,
  type TurnkeyProviderConfig,
  type UtilaProviderConfig,
} from "@/services/domain/signing/provider-config";
import {
  normalizeAnchorageWalletId,
  normalizeCoinbaseCdpWalletId,
  normalizeParaWalletId,
  normalizePrivyWalletId,
  normalizeTurnkeyWalletId,
  normalizeUtilaWalletId,
} from "@/services/domain/signing/provider-wallet-ids";
import {
  createProviderWallet,
  deleteProviderWallet,
} from "@/services/domain/signing/provider-wallet-lifecycle";
import { createEncryptionService, type EncryptionService } from "@/services/encryption.service";
import type { SigningPort, SignRequest, SignResult, SignStatus } from "@/services/ports";
import { isFullSigningPort, SigningError } from "@/services/ports";
import { assertProviderAvailable } from "@/services/provider-availability.service";
import {
  CustodyConfigStore,
  type CustodyWallet,
  type CustodyWalletLookup,
  SigningRequestStorePg,
  type WalletPurpose,
} from "@/services/stores/custody-config.store";
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
  apiBaseUrl?: string;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Privy provider.
 */
export interface InitPrivySigningOptions {
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Coinbase CDP provider.
 */
export interface InitCoinbaseCdpSigningOptions {
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
  walletAddress?: string;
  accountPolicy?: string;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Para provider.
 */
export interface InitParaSigningOptions {
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Turnkey provider.
 */
export interface InitTurnkeySigningOptions {
  apiBaseUrl?: string;
  requestDelayMs?: number;
  privateKeyId?: string;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with DFNS provider.
 */
export interface InitDfnsSigningOptions {
  apiBaseUrl?: string;
  network?: "Solana" | "SolanaDevnet";
  walletId?: string;
  signingKeyId?: string;
  walletLabel?: string;
}

/**
 * Options for initializing org signing with Anchorage provider.
 *
 * Anchorage currently supports wallet lifecycle only (create/delete), not signing.
 */
export interface InitAnchorageSigningOptions {
  apiBaseUrl?: string;
  walletId?: string;
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

export interface CustodyWalletWithProvider extends CustodyWallet {
  provider: SigningConfiguration["provider"];
  isDefaultProvider: boolean;
}

interface ListWalletsOptions {
  provider?: SigningConfiguration["provider"];
  includeAllProviders?: boolean;
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
  private encryptionService: EncryptionService | null = null;

  constructor(
    private configStore: SigningConfigStore & {
      createWallet: CustodyConfigStore["createWallet"];
      getWallets: CustodyConfigStore["getWallets"];
      getWalletsForConfigs: CustodyConfigStore["getWalletsForConfigs"];
      findActiveWalletByIdentifier: CustodyConfigStore["findActiveWalletByIdentifier"];
      deactivateWallet: CustodyConfigStore["deactivateWallet"];
      deactivateWalletIfNotLast: CustodyConfigStore["deactivateWalletIfNotLast"];
      reactivateWallet: CustodyConfigStore["reactivateWallet"];
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
  ): Promise<void> {
    const config = await this.configStore.getById(configId);
    if (!config || config.organizationId !== orgId || config.status !== "active") {
      throw new SigningError("Custody configuration not found", "NOT_FOUND");
    }

    await this.assertProviderEnabled(orgId, config.provider);
    await this.configStore.setDefaultConfig(orgId, projectId, configId);
    this.providerCache.clear();
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
      apiBaseUrl: options.apiBaseUrl,
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
    const provisioned = await custodyProvisioning.provisionPrivyWallet(this.env, {
      apiBaseUrl: options.apiBaseUrl,
    });
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

    const reusable = options.walletAddress
      ? null
      : await this.findReusableProviderWallet(orgId, projectId, "coinbase_cdp");

    if (reusable) {
      const configJson: CoinbaseCdpProviderConfig = {
        provider: "coinbase_cdp",
        apiBaseUrl: options.apiBaseUrl,
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
      apiBaseUrl: options.apiBaseUrl,
      network: options.network,
      walletAddress: options.walletAddress,
      accountPolicy: options.accountPolicy,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeCoinbaseCdpWalletId(provisioned.address);

    const configJson: CoinbaseCdpProviderConfig = {
      provider: "coinbase_cdp",
      apiBaseUrl: options.apiBaseUrl,
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

    const reusable = options.walletId
      ? null
      : await this.findReusableProviderWallet(orgId, projectId, "para");

    if (reusable) {
      const configJson: ParaProviderConfig = {
        provider: "para",
        apiBaseUrl: options.apiBaseUrl,
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
      apiBaseUrl: options.apiBaseUrl,
      walletId: options.walletId,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeParaWalletId(provisioned.walletId);

    const configJson: ParaProviderConfig = {
      provider: "para",
      apiBaseUrl: options.apiBaseUrl,
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

    const reusable = options.privateKeyId
      ? null
      : await this.findReusableProviderWallet(orgId, projectId, "turnkey");

    if (reusable) {
      const reusablePublicKey = reusable.wallet.publicKey as Address;
      const configJson: TurnkeyProviderConfig = {
        provider: "turnkey",
        organizationId: this.env.TURNKEY_ORGANIZATION_ID,
        apiBaseUrl: options.apiBaseUrl,
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
      privateKeyId: options.privateKeyId,
      apiBaseUrl: options.apiBaseUrl,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeTurnkeyWalletId(provisioned.privateKeyId);

    const configJson: TurnkeyProviderConfig = {
      provider: "turnkey",
      organizationId: this.env.TURNKEY_ORGANIZATION_ID,
      apiBaseUrl: options.apiBaseUrl,
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

    const client = await createDfnsApiClient(this.env, { apiBaseUrl: options.apiBaseUrl });
    const resolvedNetwork = resolveDfnsNetwork(options.network);

    const wallet = options.walletId
      ? await client.wallets.getWallet({ walletId: options.walletId })
      : await client.wallets.createWallet({
          body: {
            network: resolvedNetwork,
            ...(options.walletLabel ? { name: options.walletLabel } : {}),
            ...(options.signingKeyId ? { signingKey: { id: options.signingKeyId } } : {}),
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
      apiBaseUrl: options.apiBaseUrl,
      network: walletNetwork,
      walletId: wallet.id,
      signingKeyId: wallet.signingKey?.id ?? options.signingKeyId,
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
      apiBaseUrl: options.apiBaseUrl,
      walletId: options.walletId,
      walletLabel: options.walletLabel,
      network: options.network,
    });

    const walletId = normalizeAnchorageWalletId(provisioned.walletId);
    const publicKey = provisioned.address as Address;
    const configJson: AnchorageProviderConfig = {
      provider: "anchorage",
      apiBaseUrl: options.apiBaseUrl,
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
        apiBaseUrl: this.env.UTILA_API_BASE_URL,
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
    const resolvedDefaultConfig = await this.configStore.findActive(orgId, projectId);
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

    if (configs.length === 0) {
      return [];
    }

    const walletsByConfigId = await this.configStore.getWalletsForConfigs(
      configs.map((config) => config.id)
    );

    return configs.flatMap((config) =>
      (walletsByConfigId.get(config.id) ?? []).map((wallet) => ({
        ...wallet,
        provider: config.provider,
        isDefaultProvider: defaultConfigId === config.id,
      }))
    );
  }

  async getWalletById(
    orgId: string,
    projectId: string | undefined,
    walletId: string
  ): Promise<CustodyWalletWithProvider | null> {
    const wallet = await this.configStore.findActiveWalletByIdentifier(orgId, projectId, walletId);
    if (!wallet) {
      return null;
    }

    const defaultConfig = await this.configStore.findActive(orgId, projectId);
    return this.mapWalletLookup(wallet, defaultConfig?.id ?? null);
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
    }
  ): Promise<CustodyWallet> {
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

    const parsed = await parseConfigRecord(this.env, orgId, config);
    const { walletId, publicKey } = await createProviderWallet({
      env: this.env,
      orgId,
      projectId,
      params: {
        label: params.label,
      },
      parsed,
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

    const parsed = await parseConfigRecord(this.env, orgId, config);
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
    const encryption = this.getEncryptionService();
    const encryptedConfig = await encryption.encrypt(
      existing.organizationId,
      JSON.stringify(config)
    );
    await db
      .prepare(
        "UPDATE custody_configs SET config_encrypted = ?, encryption_version = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(encryptedConfig.ciphertext, "sdp-custody-encryption-v1", configId)
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

    const adapter = await createAdapterFromEncryptedConfig(this.env, orgId, config);

    this.providerCache.set(cacheKey, adapter);
    return adapter;
  }

  private async resolveAdapterForRequest(
    orgId: string,
    projectId: string | undefined,
    walletId?: string | null
  ): Promise<{ adapter: SigningPort; walletId?: string; walletPublicKey?: Address }> {
    if (!walletId) {
      const config = await this.configStore.findActive(orgId, projectId);
      const adapter = await this.getAdapterForConfig(orgId, config);
      return { adapter };
    }

    const walletRow = projectId
      ? await getDb(this.env)
          .prepare(
            `SELECT c.id as custody_config_id, c.project_id as project_id, w.public_key as wallet_public_key
             FROM custody_wallets w
             JOIN custody_configs c ON c.id = w.custody_config_id
             WHERE c.organization_id = ?
               AND w.wallet_id = ?
               AND c.status = 'active'
               AND w.status = 'active'
               AND (c.project_id = ? OR c.project_id IS NULL)
             ORDER BY CASE WHEN c.project_id = ? THEN 0 ELSE 1 END, c.updated_at DESC, c.id DESC
             LIMIT 1`
          )
          .bind(orgId, walletId, projectId, projectId)
          .first<{
            custody_config_id: string;
            project_id: string | null;
            wallet_public_key: string;
          }>()
      : await getDb(this.env)
          .prepare(
            `SELECT c.id as custody_config_id, c.project_id as project_id, w.public_key as wallet_public_key
             FROM custody_wallets w
             JOIN custody_configs c ON c.id = w.custody_config_id
             WHERE c.organization_id = ?
               AND w.wallet_id = ?
               AND c.status = 'active'
               AND w.status = 'active'
               AND c.project_id IS NULL
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT 1`
          )
          .bind(orgId, walletId)
          .first<{
            custody_config_id: string;
            project_id: string | null;
            wallet_public_key: string;
          }>();

    if (!walletRow) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }

    const config = await this.configStore.getById(walletRow.custody_config_id);
    if (!config || config.organizationId !== orgId || config.status !== "active") {
      throw new SigningError("Custody configuration not found", "WALLET_NOT_FOUND");
    }

    const adapter = await this.getAdapterForConfig(orgId, config);
    return { adapter, walletId, walletPublicKey: walletRow.wallet_public_key as Address };
  }

  /**
   * Get the public key for the signing wallet.
   */
  async getPublicKey(orgId: string, projectId?: string, walletId?: string): Promise<Address> {
    if (!walletId) {
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

  private mapWalletLookup(
    wallet: CustodyWalletLookup,
    defaultConfigId: string | null
  ): CustodyWalletWithProvider {
    return {
      id: wallet.id,
      custodyConfigId: wallet.custodyConfigId,
      walletId: wallet.walletId,
      publicKey: wallet.publicKey,
      label: wallet.label,
      purpose: wallet.purpose,
      status: wallet.status,
      createdAt: wallet.createdAt,
      provider: wallet.provider,
      isDefaultProvider: defaultConfigId === wallet.custodyConfigId,
    };
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
    const configId = await this.configStore.upsert(orgId, projectId, config);
    await this.ensureScopeDefaultConfig(orgId, projectId, configId, config.provider);

    // Invalidate cache for this config.
    this.providerCache.delete(configId);
  }

  /**
   * Get the current signing configuration.
   */
  async getConfiguration(orgId: string, projectId?: string): Promise<SigningConfigRecord | null> {
    return this.configStore.findActive(orgId, projectId);
  }

  async getConfigurations(orgId: string, projectId?: string): Promise<SigningConfigurationsResult> {
    const [configs, resolvedDefault] = await Promise.all([
      this.getScopeAndFallbackConfigs(orgId, projectId),
      this.configStore.findActive(orgId, projectId),
    ]);

    return {
      configs,
      defaultConfigId: resolvedDefault?.id ?? null,
    };
  }

  /**
   * Check if the current provider requires async approval.
   */
  async requiresApproval(orgId: string, projectId?: string): Promise<boolean> {
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
 * @param env - Cloudflare Worker environment bindings
 * @returns Configured SigningService instance
 */
export function createSigningService(env: Env): SigningService {
  const configStore = new CustodyConfigStore(getDb(env), env.CUSTODY_ENCRYPTION_KEY);
  const signingStore = new SigningRequestStorePg(getDb(env));

  return new SigningService(configStore, signingStore, env);
}
