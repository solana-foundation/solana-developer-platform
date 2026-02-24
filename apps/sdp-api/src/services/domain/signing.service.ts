/**
 * Signing Service
 *
 * Domain service for managing signing operations and provider resolution.
 * Handles 3-tier config resolution (project → org → env) and async signing flows.
 */

import {
  KeychainCoinbaseAdapter,
  KeychainDfnsAdapter,
  KeychainFireblocksAdapter,
  KeychainMemoryAdapter,
  KeychainParaAdapter,
  KeychainPrivyAdapter,
  KeychainTurnkeyAdapter,
  type SigningConfigRecord,
  createSigningAdapter,
  createSigningAdapterFromConfig,
} from "@/services/adapters";
import {
  provisionCoinbaseCdpAccount,
  provisionDfnsWallet,
  provisionParaWallet,
  provisionPrivyWallet,
  provisionTurnkeyPrivateKey,
} from "@/services/custody/provisioning";
import { createDfnsApiClient, normalizeDfnsWalletId } from "@/services/dfns/client";
import { type EncryptionService, createEncryptionService } from "@/services/encryption.service";
import type { SignRequest, SignResult, SignStatus, SigningPort } from "@/services/ports";
import { SigningError } from "@/services/ports";
import {
  CustodyConfigStore,
  type CustodyWallet,
  SigningRequestD1Store,
  type WalletPurpose,
} from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { getBase58Codec } from "@solana/codecs";
import type { Address, KeyPairSigner, TransactionSigner } from "@solana/kit";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/signers";

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
  findByProvider(
    orgId: string,
    projectId: string | undefined,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord | null>;
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
  provider: "local" | "fireblocks" | "privy" | "coinbase_cdp" | "para" | "turnkey" | "dfns";
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
  walletId?: string;
  network?: "Solana" | "SolanaDevnet";
  signingKeyId?: string;
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

type ReusableSigningProvider = "privy" | "coinbase_cdp" | "para" | "turnkey" | "dfns";

export type ProviderReuseState = Record<ReusableSigningProvider, boolean>;

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
    const [privy, coinbaseCdp, para, turnkey, dfns] = await Promise.all([
      this.findExistingProviderWallet(orgId, projectId, "privy"),
      this.findExistingProviderWallet(orgId, projectId, "coinbase_cdp"),
      this.findExistingProviderWallet(orgId, projectId, "para"),
      this.findExistingProviderWallet(orgId, projectId, "turnkey"),
      this.findExistingProviderWallet(orgId, projectId, "dfns"),
    ]);

    return {
      privy: Boolean(privy),
      coinbase_cdp: Boolean(coinbaseCdp),
      para: Boolean(para),
      turnkey: Boolean(turnkey),
      dfns: Boolean(dfns),
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
    // Check if config already exists
    const existing = await this.configStore.findActive(orgId, projectId);
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
    // Check if config already exists
    const existing = await this.configStore.findActive(orgId, projectId);
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
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    // Provision a new Privy server wallet under the platform app.
    const provisioned = await provisionPrivyWallet(this.env, { apiBaseUrl: options.apiBaseUrl });
    const publicKey = provisioned.address as Address;
    const walletId = normalizePrivyWalletId(provisioned.walletId);

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "privy",
      defaultWalletId: walletId,
    });

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
   *
   * Note: this currently provisions and manages wallet metadata only.
   * Runtime transaction signing through keychain is intentionally not enabled yet.
   */
  async initializeCoinbaseCdpSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitCoinbaseCdpSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActive(orgId, projectId);
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
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await provisionCoinbaseCdpAccount(this.env, {
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
    const existing = await this.configStore.findActive(orgId, projectId);
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
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await provisionParaWallet(this.env, {
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
    const existing = await this.configStore.findActive(orgId, projectId);
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
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusablePublicKey,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await provisionTurnkeyPrivateKey(this.env, {
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
   * DFNS credentials are platform-managed and wallets are provisioned per
   * organization/project scope.
   */
  async initializeDfnsSigning(
    orgId: string,
    projectId: string | undefined,
    options: InitDfnsSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActive(orgId, projectId);
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId}${projectId ? ` project ${projectId}` : ""}`,
        "ALREADY_INITIALIZED"
      );
    }

    const reusable = options.walletId
      ? null
      : await this.findReusableProviderWallet(orgId, projectId, "dfns");

    if (reusable) {
      const configJson: DfnsProviderConfig = {
        provider: "dfns",
        apiBaseUrl: options.apiBaseUrl,
        network: options.network,
      };

      await this.updateConfigJson(reusable.configId, configJson);
      this.providerCache.delete(reusable.configId);

      return {
        configId: reusable.configId,
        publicKey: reusable.wallet.publicKey as Address,
        walletId: reusable.wallet.walletId,
      };
    }

    const provisioned = await provisionDfnsWallet(this.env, {
      orgId,
      orgSlug: orgId,
      apiBaseUrl: options.apiBaseUrl,
      walletId: options.walletId,
      walletName: options.walletLabel,
      network: options.network,
      signingKeyId: options.signingKeyId,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeDfnsWalletId(provisioned.walletId);

    const configJson: DfnsProviderConfig = {
      provider: "dfns",
      apiBaseUrl: options.apiBaseUrl,
      network: provisioned.network,
      walletId: provisioned.walletId,
      signingKeyId: provisioned.signingKeyId,
    };

    const configId = await this.configStore.upsert(orgId, projectId, {
      provider: "dfns",
      defaultWalletId: walletId,
    });

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
   * Provision a new wallet in custody for the resolved provider configuration.
   *
   * For V1 we support wallet provisioning for Privy, Coinbase CDP, Para, Turnkey, and DFNS
   * providers.
   */
  async createWallet(
    orgId: string,
    projectId: string | undefined,
    params: { label?: string; purpose?: WalletPurpose; setDefault?: boolean }
  ): Promise<CustodyWallet> {
    const config = await this.configStore.findActive(orgId, projectId);
    if (!config) {
      throw new SigningError("Custody not initialized", "NOT_FOUND");
    }

    if (
      config.provider !== "privy" &&
      config.provider !== "coinbase_cdp" &&
      config.provider !== "para" &&
      config.provider !== "turnkey" &&
      config.provider !== "dfns"
    ) {
      throw new SigningError(
        `Wallet provisioning not supported for provider: ${config.provider}`,
        "INVALID_REQUEST"
      );
    }

    const parsed = await parseConfigRecord(this.env, orgId, config);
    let walletId: string;
    let publicKey: string;

    if (parsed.provider === "privy") {
      const apiBaseUrl = parsed.apiBaseUrl ?? this.env.PRIVY_API_BASE_URL;
      let provisioned: { walletId: string; address: string };
      try {
        provisioned = await provisionPrivyWallet(this.env, { apiBaseUrl });
      } catch (error) {
        if (error instanceof SigningError) {
          throw error;
        }

        throw new SigningError(
          `Failed to provision Privy wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
          "NETWORK_ERROR",
          error instanceof Error ? error : undefined
        );
      }

      walletId = normalizePrivyWalletId(provisioned.walletId);
      publicKey = provisioned.address;
    } else if (parsed.provider === "coinbase_cdp") {
      let provisioned: { address: string };
      try {
        provisioned = await provisionCoinbaseCdpAccount(this.env, {
          orgId,
          orgSlug: orgId,
          apiBaseUrl: parsed.apiBaseUrl ?? this.env.COINBASE_CDP_API_BASE_URL,
          network: parsed.network ?? this.env.COINBASE_CDP_NETWORK,
          accountPolicy: parsed.accountPolicy,
        });
      } catch (error) {
        if (error instanceof SigningError) {
          throw error;
        }

        throw new SigningError(
          `Failed to provision Coinbase CDP wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
          "NETWORK_ERROR",
          error instanceof Error ? error : undefined
        );
      }

      walletId = normalizeCoinbaseCdpWalletId(provisioned.address);
      publicKey = provisioned.address;
    } else if (parsed.provider === "para") {
      let provisioned: { walletId: string; address: string };
      try {
        provisioned = await provisionParaWallet(this.env, {
          orgId,
          projectId,
          orgSlug: orgId,
          apiBaseUrl: parsed.apiBaseUrl ?? this.env.PARA_API_BASE_URL,
        });
      } catch (error) {
        if (error instanceof SigningError) {
          throw error;
        }

        throw new SigningError(
          `Failed to provision Para wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
          "NETWORK_ERROR",
          error instanceof Error ? error : undefined
        );
      }

      walletId = normalizeParaWalletId(provisioned.walletId);
      publicKey = provisioned.address;
    } else if (parsed.provider === "turnkey") {
      let provisioned: { privateKeyId: string; address: string };
      try {
        provisioned = await provisionTurnkeyPrivateKey(this.env, {
          orgId,
          orgSlug: orgId,
          apiBaseUrl: parsed.apiBaseUrl ?? this.env.TURNKEY_API_BASE_URL,
        });
      } catch (error) {
        if (error instanceof SigningError) {
          throw error;
        }

        throw new SigningError(
          `Failed to provision Turnkey wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
          "NETWORK_ERROR",
          error instanceof Error ? error : undefined
        );
      }

      walletId = normalizeTurnkeyWalletId(provisioned.privateKeyId);
      publicKey = provisioned.address;
    } else if (parsed.provider === "dfns") {
      let provisioned: {
        walletId: string;
        address: string;
        network: "Solana" | "SolanaDevnet";
        signingKeyId: string;
      };
      try {
        provisioned = await provisionDfnsWallet(this.env, {
          orgId,
          orgSlug: orgId,
          apiBaseUrl: parsed.apiBaseUrl ?? this.env.DFNS_API_BASE_URL,
          network: parsed.network,
          walletName: params.label,
          signingKeyId: parsed.signingKeyId,
        });
      } catch (error) {
        if (error instanceof SigningError) {
          throw error;
        }

        throw new SigningError(
          `Failed to provision DFNS wallet: ${error instanceof Error ? error.message : "Unknown error"}`,
          "NETWORK_ERROR",
          error instanceof Error ? error : undefined
        );
      }

      walletId = normalizeDfnsWalletId(provisioned.walletId);
      publicKey = provisioned.address;
    } else {
      throw new SigningError(
        `Wallet provisioning not supported for provider: ${parsed.provider}`,
        "INVALID_REQUEST"
      );
    }

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
        await this.env.DB.prepare(
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
  ): Promise<void> {
    // This would normally be a direct DB update, but we'll use the upsert pattern
    // The config JSON is stored in the `config_encrypted` column of custody_configs
    const configStore = this.configStore as CustodyConfigStore;
    const existing = await configStore.getById(configId);
    if (!existing) {
      throw new SigningError("Config not found", "NOT_FOUND");
    }

    // Direct D1 update for the config JSON
    // This is safe because we're only updating our own config
    const db = this.env.DB;
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
   * 1. Project-specific config (if projectId provided)
   * 2. Organization-level config
   * 3. Environment fallback (KeychainMemoryAdapter with CUSTODY_PRIVATE_KEY)
   */
  async getAdapter(orgId: string, projectId?: string): Promise<SigningPort> {
    const config = await this.configStore.findActive(orgId, projectId);
    return this.getAdapterForConfig(orgId, config);
  }

  private async getAdapterForConfig(
    orgId: string,
    config: SigningConfigRecord | null
  ): Promise<SigningPort> {
    const cacheKey = config?.id ?? ENV_FALLBACK_CONFIG_ID;

    const cached = this.providerCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const adapter = config
      ? await createAdapterFromEncryptedConfig(this.env, orgId, config)
      : await createSigningAdapter(this.env, null);

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

    const walletRow = await this.env.DB.prepare(
      `SELECT c.id as custody_config_id, c.project_id as project_id, w.public_key as wallet_public_key
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
       WHERE c.organization_id = ? AND w.wallet_id = ? AND c.status = 'active' AND w.status = 'active'
       LIMIT 1`
    )
      .bind(orgId, walletId)
      .first<{ custody_config_id: string; project_id: string | null; wallet_public_key: string }>();

    if (!walletRow) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }

    // Org-level keys cannot reference project-scoped wallets.
    if (!projectId && walletRow.project_id) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }

    // Project-scoped keys can reference org-level wallets or wallets in the same project.
    if (projectId && walletRow.project_id && walletRow.project_id !== projectId) {
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
      return adapter.getTransactionSigner();
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

    if (adapter instanceof KeychainMemoryAdapter) {
      return adapter.getTransactionSigner();
    }

    if (adapter instanceof KeychainFireblocksAdapter) {
      return adapter.getTransactionSigner();
    }

    if (adapter instanceof KeychainPrivyAdapter) {
      return adapter.getTransactionSigner(resolved.walletId);
    }

    if (adapter instanceof KeychainCoinbaseAdapter) {
      return adapter.getTransactionSigner(resolved.walletId);
    }

    if (adapter instanceof KeychainParaAdapter) {
      return adapter.getTransactionSigner(resolved.walletId);
    }

    if (adapter instanceof KeychainTurnkeyAdapter) {
      return adapter.getTransactionSigner(resolved.walletId, resolved.walletPublicKey);
    }

    if (adapter instanceof KeychainDfnsAdapter) {
      return adapter.getTransactionSigner(resolved.walletId);
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
    const configId = await this.configStore.upsert(orgId, projectId, config);

    // Invalidate cache for this config.
    this.providerCache.delete(configId);
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

function normalizePrivyWalletId(walletId: string): string {
  return walletId.startsWith("privy_") ? walletId : `privy_${walletId}`;
}

function normalizeCoinbaseCdpWalletId(walletAddress: string): string {
  return walletAddress.startsWith("cdp_") ? walletAddress : `cdp_${walletAddress}`;
}

function normalizeParaWalletId(walletId: string): string {
  return walletId.startsWith("para_") ? walletId : `para_${walletId}`;
}

function normalizeTurnkeyWalletId(privateKeyId: string): string {
  return privateKeyId.startsWith("turnkey_") ? privateKeyId : `turnkey_${privateKeyId}`;
}

function parseOptionalRequestDelayMs(
  value?: string,
  options?: { envVarName?: string }
): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new SigningError(
      `${options?.envVarName ?? "REQUEST_DELAY_MS"} must be a non-negative number`,
      "INVALID_REQUEST"
    );
  }
  return parsed;
}

/**
 * Export the secret key bytes from a KeyPairSigner.
 * Returns the 64-byte secret key (32 private + 32 public).
 */

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

interface PrivyProviderConfig {
  provider: "privy";
  // Legacy (pre reseller model): credentials stored in D1.
  appId?: string;
  appSecretEncrypted?: string;
  walletId?: string;
  apiBaseUrl?: string;
  requestDelayMs?: number;
  // Reseller model (platform-managed): non-secret metadata only.
  privyAppId?: string;
}

interface CoinbaseCdpProviderConfig {
  provider: "coinbase_cdp";
  apiBaseUrl?: string;
  network?: "solana" | "solana-devnet";
  accountPolicy?: string;
  requestDelayMs?: number;
}

interface ParaProviderConfig {
  provider: "para";
  apiBaseUrl?: string;
  requestDelayMs?: number;
  walletId?: string;
  userIdentifier?: string;
  userIdentifierType?: "CUSTOM_ID";
}

interface TurnkeyProviderConfig {
  provider: "turnkey";
  organizationId?: string;
  apiBaseUrl?: string;
  requestDelayMs?: number;
  privateKeyId?: string;
  defaultWalletPublicKey?: string;
}

interface DfnsProviderConfig {
  provider: "dfns";
  apiBaseUrl?: string;
  network?: "Solana" | "SolanaDevnet";
  walletId?: string;
  signingKeyId?: string;
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
  const configStore = new CustodyConfigStore(env.DB, env.CUSTODY_ENCRYPTION_KEY);
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
  const parsed = await parseConfigRecord(env, orgId, record);

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

  // biome-ignore lint/nursery/noSecrets: This is a type guard, not a secret
  if (parsed.provider === "privy" && "appSecretEncrypted" in parsed) {
    if (!parsed.appId || !parsed.walletId) {
      throw new SigningError("Privy config missing appId or walletId", "PROVIDER_NOT_CONFIGURED");
    }

    if (!parsed.appSecretEncrypted) {
      // biome-ignore lint/nursery/noSecrets: Not a secret, just a field name in an error message
      throw new SigningError("Privy config missing appSecretEncrypted", "PROVIDER_NOT_CONFIGURED");
    }

    // Decrypt the app secret
    const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
    const appSecret = await encryption.decryptPrivateKey(orgId, parsed.appSecretEncrypted);

    // Create Privy adapter with decrypted secret
    return new KeychainPrivyAdapter({
      appId: parsed.appId,
      appSecret,
      apiBaseUrl: parsed.apiBaseUrl,
      requestDelayMs: parsed.requestDelayMs,
      defaultWalletId: record.defaultWalletId ?? normalizePrivyWalletId(parsed.walletId),
    });
  }

  if (parsed.provider === "privy") {
    const appId = env.PRIVY_APP_ID ?? parsed.privyAppId ?? parsed.appId;
    const appSecret = env.PRIVY_APP_SECRET;

    if (!appId || !appSecret) {
      throw new SigningError(
        "Privy environment variables not configured: PRIVY_APP_ID, PRIVY_APP_SECRET",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    const requestDelayMs =
      parsed.requestDelayMs ??
      parseOptionalRequestDelayMs(env.PRIVY_REQUEST_DELAY_MS, {
        envVarName: "PRIVY_REQUEST_DELAY_MS",
      });

    const defaultWalletId =
      record.defaultWalletId ??
      (parsed.walletId ? normalizePrivyWalletId(parsed.walletId) : undefined);

    if (!defaultWalletId) {
      throw new SigningError("Privy config missing default wallet ID", "PROVIDER_NOT_CONFIGURED");
    }

    return new KeychainPrivyAdapter({
      appId,
      appSecret,
      apiBaseUrl: parsed.apiBaseUrl ?? env.PRIVY_API_BASE_URL,
      requestDelayMs,
      defaultWalletId,
    });
  }

  if (parsed.provider === "coinbase_cdp") {
    const apiKeyId = env.COINBASE_CDP_API_KEY_ID;
    const apiKeySecret = env.COINBASE_CDP_API_KEY_SECRET;
    const walletSecret = env.COINBASE_CDP_WALLET_SECRET;
    const defaultWalletId = record.defaultWalletId ?? env.COINBASE_CDP_WALLET_ID;

    if (!apiKeyId || !apiKeySecret || !walletSecret || !defaultWalletId) {
      throw new SigningError(
        "Coinbase CDP environment variables not configured: COINBASE_CDP_API_KEY_ID, COINBASE_CDP_API_KEY_SECRET, COINBASE_CDP_WALLET_SECRET, COINBASE_CDP_WALLET_ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainCoinbaseAdapter({
      apiKeyId,
      apiKeySecret,
      walletSecret,
      apiBaseUrl: parsed.apiBaseUrl ?? env.COINBASE_CDP_API_BASE_URL,
      requestDelayMs: parsed.requestDelayMs,
      defaultWalletId,
    });
  }

  if (parsed.provider === "para") {
    const apiKey = env.PARA_API_KEY;
    const requestDelayMs =
      parsed.requestDelayMs ??
      parseOptionalRequestDelayMs(env.PARA_REQUEST_DELAY_MS, {
        envVarName: "PARA_REQUEST_DELAY_MS",
      });

    const defaultWalletId =
      record.defaultWalletId ??
      (parsed.walletId ? normalizeParaWalletId(parsed.walletId) : undefined) ??
      (env.PARA_WALLET_ID ? normalizeParaWalletId(env.PARA_WALLET_ID) : undefined);

    if (!apiKey || !defaultWalletId) {
      throw new SigningError(
        "Para environment variables not configured: PARA_API_KEY, PARA_WALLET_ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainParaAdapter({
      apiKey,
      apiBaseUrl: parsed.apiBaseUrl ?? env.PARA_API_BASE_URL,
      requestDelayMs,
      defaultWalletId,
    });
  }

  if (parsed.provider === "turnkey") {
    const apiPublicKey = env.TURNKEY_API_PUBLIC_KEY;
    const apiPrivateKey = env.TURNKEY_API_PRIVATE_KEY;
    const organizationId = parsed.organizationId ?? env.TURNKEY_ORGANIZATION_ID;
    const requestDelayMs =
      parsed.requestDelayMs ??
      parseOptionalRequestDelayMs(env.TURNKEY_REQUEST_DELAY_MS, {
        envVarName: "TURNKEY_REQUEST_DELAY_MS",
      });

    const defaultWalletId =
      record.defaultWalletId ??
      (parsed.privateKeyId ? normalizeTurnkeyWalletId(parsed.privateKeyId) : undefined) ??
      (env.TURNKEY_PRIVATE_KEY_ID
        ? normalizeTurnkeyWalletId(env.TURNKEY_PRIVATE_KEY_ID)
        : undefined);

    let defaultWalletPublicKey = parsed.defaultWalletPublicKey ?? env.TURNKEY_PUBLIC_KEY;
    if (!defaultWalletPublicKey && defaultWalletId) {
      const wallet = await env.DB.prepare(
        `SELECT public_key
         FROM custody_wallets
         WHERE custody_config_id = ? AND wallet_id = ? AND status = 'active'
         LIMIT 1`
      )
        .bind(record.id, defaultWalletId)
        .first<{ public_key: string }>();
      defaultWalletPublicKey = wallet?.public_key;
    }

    if (
      !apiPublicKey ||
      !apiPrivateKey ||
      !organizationId ||
      !defaultWalletId ||
      !defaultWalletPublicKey
    ) {
      throw new SigningError(
        "Turnkey environment variables not configured: TURNKEY_API_PUBLIC_KEY, TURNKEY_API_PRIVATE_KEY, TURNKEY_ORGANIZATION_ID, TURNKEY_PRIVATE_KEY_ID, TURNKEY_PUBLIC_KEY",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainTurnkeyAdapter({
      apiPublicKey,
      apiPrivateKey,
      organizationId,
      apiBaseUrl: parsed.apiBaseUrl ?? env.TURNKEY_API_BASE_URL,
      requestDelayMs,
      defaultWalletId,
      defaultWalletPublicKey,
    });
  }

  if (parsed.provider === "dfns") {
    const defaultWalletId =
      record.defaultWalletId ??
      (parsed.walletId ? normalizeDfnsWalletId(parsed.walletId) : undefined) ??
      (env.DFNS_WALLET_ID ? normalizeDfnsWalletId(env.DFNS_WALLET_ID) : undefined);

    if (!defaultWalletId) {
      throw new SigningError(
        "DFNS environment variables not configured: DFNS_WALLET_ID",
        "PROVIDER_NOT_CONFIGURED"
      );
    }

    return new KeychainDfnsAdapter({
      client: await createDfnsApiClient(env, { apiBaseUrl: parsed.apiBaseUrl }),
      defaultWalletId,
    });
  }

  // Fall back to standard config creation (for backward compatibility)
  return createSigningAdapterFromConfig(record, env);
}

async function parseConfigRecord(
  env: Env,
  orgId: string,
  record: SigningConfigRecord
): Promise<
  | LocalProviderConfig
  | FireblocksProviderConfig
  | PrivyProviderConfig
  | CoinbaseCdpProviderConfig
  | ParaProviderConfig
  | TurnkeyProviderConfig
  | DfnsProviderConfig
> {
  try {
    return JSON.parse(record.config) as
      | LocalProviderConfig
      | FireblocksProviderConfig
      | PrivyProviderConfig
      | CoinbaseCdpProviderConfig
      | ParaProviderConfig
      | TurnkeyProviderConfig
      | DfnsProviderConfig;
  } catch {
    // Encrypted payload: decrypt then parse.
    try {
      const encryption = createEncryptionService(env.CUSTODY_ENCRYPTION_KEY);
      const decrypted = await encryption.decrypt(orgId, record.config);
      return JSON.parse(decrypted) as
        | LocalProviderConfig
        | FireblocksProviderConfig
        | PrivyProviderConfig
        | CoinbaseCdpProviderConfig
        | ParaProviderConfig
        | TurnkeyProviderConfig
        | DfnsProviderConfig;
    } catch (error) {
      throw new SigningError(
        error instanceof Error ? error.message : "Failed to decrypt custody configuration",
        "PROVIDER_NOT_CONFIGURED"
      );
    }
  }
}
