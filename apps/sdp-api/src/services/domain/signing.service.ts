/**
 * Signing Service
 *
 * Domain service for managing signing operations and provider resolution.
 * Handles DB-backed config resolution and Kit signer access for exact custody wallets.
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
import type { SigningPort } from "@sdp/custody/signing";
import { SigningError } from "@sdp/custody/signing";
import { getBase58Codec } from "@solana/codecs";
import type { Address, TransactionSigner } from "@solana/kit";
import { createKeyPairSignerFromPrivateKeyBytes } from "@solana/signers";
import { getDb } from "@/db";
import { AppError } from "@/lib/errors";
import { assertTenantClaim, type TenantScope } from "@/lib/tenant-scope";
import { KeychainFireblocksAdapter, type SigningConfigRecord } from "@/services/adapters";
import { assertLocalSigningAllowed } from "@/services/adapters/signing";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import {
  assertCustodyProviderCanCreateWallet,
  assertCustodyProviderCanDeleteWallet,
} from "@/services/custody-provider-lifecycle.service";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createAdapterFromEncryptedConfig } from "@/services/domain/signing/provider-adapter-factory";
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
  assertCustodyProviderAvailable,
  assertManagedCustodyUseAllowed,
  assertProviderAvailable,
} from "@/services/provider-availability.service";
import {
  CustodyConfigStore,
  type CustodyConfigWallet,
  type CustodyWallet,
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
  listActive(orgId: string, projectId: string): Promise<SigningConfigRecord[]>;
  findByProvider(
    orgId: string,
    projectId: string,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord | null>;
  findActiveByProvider(
    orgId: string,
    projectId: string,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord | null>;
  getById(configId: string): Promise<SigningConfigRecord | null>;
}

/**
 * Signing configuration (union of provider-specific configs)
 */
export interface SigningConfiguration {
  provider: CustodyProvider;
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

/** Full provider payload stored encrypted in custody_configs.config_encrypted. */
type ProviderConfigJson =
  | LocalProviderConfig
  | FireblocksProviderConfig
  | PrivyProviderConfig
  | CoinbaseCdpProviderConfig
  | ParaProviderConfig
  | TurnkeyProviderConfig
  | DfnsProviderConfig
  | IbmHavenProviderConfig
  | AnchorageProviderConfig
  | UtilaProviderConfig;

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
  private readonly runtimeTargets: CustodyRuntimeTargets;

  constructor(
    private configStore: SigningConfigStore & {
      saveProviderConfig: CustodyConfigStore["saveProviderConfig"];
      createWallet: CustodyConfigStore["createWallet"];
      getWallets: CustodyConfigStore["getWallets"];
      deactivateWallet: CustodyConfigStore["deactivateWallet"];
      deactivateWalletIfNotLast: CustodyConfigStore["deactivateWalletIfNotLast"];
      reactivateWallet: CustodyConfigStore["reactivateWallet"];
    },
    private env: Env
  ) {
    this.runtimeTargets = new CustodyRuntimeTargets(getDb(env), env, this.providerCache);
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

  /**
   * Refuses using a Managed custody config unless the (provider, managed) pair is
   * in the release channel, the config's project allows Managed custody
   * (Production is BYOK only) and the organization has the provider enabled.
   * Every Managed use passes here before any decrypt or provider call: wallet
   * creation and deletion, and the adapter every signer and public-key read
   * builds. The channel and environment refusals keep their 403s; the
   * entitlement refusal is a signing error.
   *
   * @param config - The Managed config about to be used.
   */
  private async assertManagedConfigUsable(config: SigningConfigRecord): Promise<void> {
    const { organizationId, projectId, provider } = config;
    assertCustodyProviderAvailable(this.env, provider, "managed");
    await assertManagedCustodyUseAllowed(getDb(this.env), { organizationId, projectId, provider });
    try {
      await assertProviderAvailable(this.env, getDb(this.env), organizationId, "custody", provider);
    } catch (error) {
      if (error instanceof AppError) {
        throw new SigningError(error.message, "INVALID_REQUEST", error);
      }
      throw error;
    }
  }

  async getConfigurationByProvider(
    orgId: string,
    projectId: string,
    provider: SigningConfiguration["provider"]
  ): Promise<SigningConfigRecord | null> {
    return this.configStore.findActiveByProvider(orgId, projectId, provider);
  }

  private async findExistingProviderWallet(
    orgId: string,
    projectId: string,
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

    const [rootWallet] = await this.configStore.getWallets(existingProviderConfig.id);
    if (!rootWallet) {
      return null;
    }

    return {
      config: existingProviderConfig,
      wallet: rootWallet,
    };
  }

  private async findReusableProviderWallet(
    orgId: string,
    projectId: string,
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

    return {
      configId: existingProviderWallet.config.id,
      wallet: existingProviderWallet.wallet,
    };
  }

  /**
   * Atomically persist a freshly provisioned provider: the config row with
   * its full encrypted payload and the root wallet record land in one
   * transaction, so the config is never readable in a partially initialized
   * state.
   */
  private async persistInitializedProvider(params: {
    orgId: string;
    projectId: string;
    configJson: ProviderConfigJson;
    walletId: string;
    publicKey: Address;
    walletLabel: string;
  }): Promise<InitSigningResult> {
    const provider = params.configJson.provider;

    const { configId } = await this.configStore.saveProviderConfig({
      orgId: params.orgId,
      projectId: params.projectId,
      provider,
      configJson: params.configJson,
      wallet: {
        walletId: params.walletId,
        publicKey: params.publicKey,
        label: params.walletLabel,
        purpose: "root",
      },
    });

    this.providerCache.delete(configId);

    return {
      configId,
      publicKey: params.publicKey,
      walletId: params.walletId,
    };
  }

  /**
   * Atomically re-activate an existing scope-local provider config around a
   * wallet that was already provisioned for this exact scope.
   */
  private async persistReusedProvider(
    orgId: string,
    projectId: string,
    configJson: ProviderConfigJson,
    reusable: { configId: string; wallet: CustodyWallet }
  ): Promise<InitSigningResult> {
    await this.configStore.saveProviderConfig({
      orgId,
      projectId,
      provider: configJson.provider,
      configJson,
    });

    this.providerCache.delete(reusable.configId);

    return {
      configId: reusable.configId,
      publicKey: reusable.wallet.publicKey as Address,
      walletId: reusable.wallet.walletId,
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
   * @param projectId - The project that owns the config
   * @param options - Optional configuration options
   * @returns The new config ID, public key, and wallet ID
   */
  async initializeLocalSigning(
    orgId: string,
    projectId: string,
    options?: InitLocalSigningOptions
  ): Promise<InitSigningResult> {
    assertLocalSigningAllowed(this.env);
    // Check if an active config already exists for this provider.
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "local");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId: keypair.address,
      publicKey: keypair.address,
      walletLabel: options?.walletLabel ?? "Root Signing Wallet",
    });
  }

  /**
   * Initialize signing for an organization with Fireblocks provider.
   *
   * @param orgId - Organization ID
   * @param projectId - The project that owns the config
   * @param options - Fireblocks configuration
   * @returns The new config ID, public key, and wallet ID
   */
  async initializeFireblocksSigning(
    orgId: string,
    projectId: string,
    options: InitFireblocksSigningOptions
  ): Promise<InitSigningResult> {
    // Check if an active config already exists for this provider.
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "fireblocks");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "Fireblocks Vault",
    });
  }

  /**
   * Initialize signing for an organization with Privy provider.
   *
   * @param orgId - Organization ID
   * @param projectId - The project that owns the config
   * @param options - Privy configuration
   * @returns The new config ID, public key, and wallet ID
   */
  async initializePrivySigning(
    orgId: string,
    projectId: string,
    options: InitPrivySigningOptions
  ): Promise<InitSigningResult> {
    // Check if an active config already exists for this provider.
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "privy");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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
      return this.persistReusedProvider(orgId, projectId, configJson, reusable);
    }

    // Provision a new Privy server wallet under the platform app.
    const provisioned = await custodyProvisioning.provisionPrivyWallet(this.env, {});
    const publicKey = provisioned.address as Address;
    const walletId = normalizePrivyWalletId(provisioned.walletId);

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "Default",
    });
  }

  /**
   * Initialize signing for an organization with Coinbase CDP provider.
   */
  async initializeCoinbaseCdpSigning(
    orgId: string,
    projectId: string,
    options: InitCoinbaseCdpSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "coinbase_cdp");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

      return this.persistReusedProvider(orgId, projectId, configJson, reusable);
    }

    // Root account: deterministic identity (org + project + network) so retries
    // after a partial failure reclaim this scope's own account — never another
    // tenant's.
    const provisioned = await custodyProvisioning.provisionCoinbaseCdpAccount(this.env, {
      orgId,
      projectId,
      network: options.network,
      accountPolicy: options.accountPolicy,
      reuseExisting: true,
    });

    const publicKey = provisioned.address as Address;
    const walletId = normalizeCoinbaseCdpWalletId(provisioned.address);

    const configJson: CoinbaseCdpProviderConfig = {
      provider: "coinbase_cdp",
      network: provisioned.network,
      accountPolicy: options.accountPolicy,
    };

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "CDP Root Wallet",
    });
  }

  /**
   * Initialize signing for an organization with Para provider.
   *
   * Para credentials are platform-managed and wallets are provisioned per
   * organization/project scope.
   */
  async initializeParaSigning(
    orgId: string,
    projectId: string,
    options: InitParaSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "para");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

      return this.persistReusedProvider(orgId, projectId, configJson, reusable);
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

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "Para Root Wallet",
    });
  }

  /**
   * Initialize signing for an organization with Turnkey provider.
   *
   * Turnkey credentials are platform-managed and wallets are provisioned per
   * organization/project scope.
   */
  async initializeTurnkeySigning(
    orgId: string,
    projectId: string,
    options: InitTurnkeySigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "turnkey");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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
      const configJson: TurnkeyProviderConfig = {
        provider: "turnkey",
        organizationId: this.env.TURNKEY_ORGANIZATION_ID,
        requestDelayMs: options.requestDelayMs,
      };

      return this.persistReusedProvider(orgId, projectId, configJson, reusable);
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
    };

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "Turnkey Root Wallet",
    });
  }

  /**
   * Initialize signing for an organization with DFNS provider.
   *
   * DFNS credentials are platform-managed via env bindings.
   */
  async initializeDfnsSigning(
    orgId: string,
    projectId: string,
    options: InitDfnsSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "dfns");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "DFNS Root Wallet",
    });
  }

  /**
   * Initialize signing for an organization with IBM Digital Asset Haven.
   *
   * IBM Digital Asset Haven is a white-label Dfns deployment, so this reuses the
   * Dfns wallet API with IBM-hosted credentials (IBM_HAVEN_* env bindings).
   */
  async initializeIbmHavenSigning(
    orgId: string,
    projectId: string,
    options: InitIbmHavenSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "ibm_haven");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "IBM Digital Asset Haven Root Wallet",
    });
  }

  /**
   * Initialize wallet lifecycle for an organization with Anchorage provider.
   *
   * Anchorage does not currently support transaction signing in SDP.
   */
  async initializeAnchorageWalletLifecycle(
    orgId: string,
    projectId: string,
    options: InitAnchorageSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "anchorage");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "Anchorage Wallet",
    });
  }

  /**
   * @deprecated Use initializeAnchorageWalletLifecycle.
   */
  async initializeAnchorageSigning(
    orgId: string,
    projectId: string,
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
    projectId: string,
    options: InitUtilaSigningOptions
  ): Promise<InitSigningResult> {
    const existing = await this.configStore.findActiveByProvider(orgId, projectId, "utila");
    if (existing) {
      throw new SigningError(
        `Signing already initialized for org ${orgId} project ${projectId}`,
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

      return this.persistReusedProvider(orgId, projectId, configJson, reusable);
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

    return this.persistInitializedProvider({
      orgId,
      projectId,
      configJson,
      walletId,
      publicKey,
      walletLabel: options.walletLabel ?? "Utila Wallet",
    });
  }

  /**
   * Provision a new wallet under the project's Managed config for the named provider.
   * A project holds one active config per provider, so the provider names it exactly.
   *
   * Providers that support wallet lifecycle are controlled by provider capability flags.
   *
   * @param orgId - The organization that owns the project.
   * @param projectId - The project whose config the wallet lives under.
   * @param params - The wallet to create.
   * @param params.provider - The provider whose Managed config owns the new wallet.
   * @param params.label - Optional wallet label.
   * @param params.purpose - Optional wallet purpose.
   * @returns The persisted config wallet.
   */
  async createWallet(
    orgId: string,
    projectId: string,
    params: {
      provider: SigningConfiguration["provider"];
      label?: string;
      purpose?: WalletPurpose;
    }
  ): Promise<CustodyConfigWallet> {
    const config = await this.configStore.findActiveByProvider(orgId, projectId, params.provider);
    if (!config) {
      throw new SigningError(
        `Custody not initialized for provider: ${params.provider}`,
        "NOT_FOUND"
      );
    }

    await this.assertManagedConfigUsable(config);
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

    let wallet: CustodyConfigWallet;
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

    return wallet;
  }

  /**
   * Delete a wallet from the config that owns it.
   *
   * Deletion support is provider-dependent. Providers without delete capability
   * will return INVALID_REQUEST.
   *
   * @param orgId - The organization that owns the project.
   * @param projectId - The project the wallet belongs to.
   * @param params - The wallet to delete.
   * @param params.walletId - The provider wallet ID.
   * @param params.configId - The config that owns the wallet row.
   * @param params.provider - When set, asserted against the owning config's provider.
   */
  async deleteWallet(
    orgId: string,
    projectId: string,
    params: {
      walletId: string;
      configId: string;
      provider?: SigningConfiguration["provider"];
    }
  ): Promise<void> {
    const config = await this.configStore.getById(params.configId);
    if (!config) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
    if (config.organizationId !== orgId || config.projectId !== projectId) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
    if (params.provider && params.provider !== config.provider) {
      throw new SigningError("Provider does not match custody wallet", "INVALID_REQUEST");
    }

    await this.assertManagedConfigUsable(config);
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
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Provider Resolution
  // ═══════════════════════════════════════════════════════════════════════════

  private async getAdapterForConfig(
    orgId: string,
    config: SigningConfigRecord
  ): Promise<SigningPort> {
    await this.assertManagedConfigUsable(config);

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

  /**
   * The public key of one of the project's active Managed config wallets. The
   * config's adapter is built first, so a provider the release channel or the
   * organization's entitlements leave out is refused before the key is answered.
   *
   * @param orgId - The organization that owns the project.
   * @param projectId - The project the wallet belongs to.
   * @param walletId - The provider wallet ID.
   * @returns The wallet's Solana address.
   */
  async getPublicKey(orgId: string, projectId: string, walletId: string): Promise<Address> {
    const walletRow = await getDb(this.env)
      .prepare(
        `SELECT c.id as custody_config_id, w.public_key as wallet_public_key
         FROM custody_wallets w
         JOIN custody_configs c ON c.id = w.custody_config_id
         WHERE c.organization_id = ?
           AND c.project_id = ?
           AND w.wallet_id = ?
           AND c.status = 'active'
           AND w.status = 'active'
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT 1`
      )
      .bind(orgId, projectId, walletId)
      .first<{ custody_config_id: string; wallet_public_key: string }>();

    if (!walletRow) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }

    const config = await this.configStore.getById(walletRow.custody_config_id);
    if (!config || config.organizationId !== orgId || config.status !== "active") {
      throw new SigningError("Custody configuration not found", "WALLET_NOT_FOUND");
    }

    await this.getAdapterForConfig(orgId, config);
    return walletRow.wallet_public_key as Address;
  }

  async admitRuntimeExecution(
    orgId: string,
    projectId: string,
    custodyWalletId: string
  ): Promise<void> {
    return this.runtimeTargets.admitRuntimeExecution({
      organizationId: orgId,
      projectId,
      custodyWalletId,
    });
  }

  async getTransactionSignerForWalletRecord(
    orgId: string,
    projectId: string,
    custodyWalletId: string
  ): Promise<TransactionSigner> {
    return this.runtimeTargets.getTransactionSignerForWalletRecord(
      orgId,
      projectId,
      custodyWalletId,
      (organizationId, config) => this.getAdapterForConfig(organizationId, config)
    );
  }

  /**
   * The project's active Managed custody configs, most recently updated first.
   *
   * @param orgId - The organization that owns the project.
   * @param projectId - The project whose configs are listed.
   * @returns The active configs.
   */
  async getConfigurations(orgId: string, projectId: string): Promise<SigningConfigRecord[]> {
    return this.configStore.listActive(orgId, projectId);
  }
}

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
export function createSigningService(env: Env, scope?: TenantScope): SigningService {
  const configStore = new CustodyConfigStore(getDb(env), env);
  const service = new SigningService(configStore, env);

  if (!scope) {
    return service;
  }

  const tenantMethods = new Set([
    "getConfigurationByProvider",
    "initializeLocalSigning",
    "initializeFireblocksSigning",
    "initializePrivySigning",
    "initializeCoinbaseCdpSigning",
    "initializeParaSigning",
    "initializeTurnkeySigning",
    "initializeDfnsSigning",
    "initializeIbmHavenSigning",
    "initializeAnchorageWalletLifecycle",
    "initializeAnchorageSigning",
    "initializeUtilaSigning",
    "createWallet",
    "deleteWallet",
    "getPublicKey",
    "admitRuntimeExecution",
    "getTransactionSignerForWalletRecord",
    "getConfigurations",
  ]);

  return new Proxy(service, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !tenantMethods.has(String(property))) {
        return value;
      }

      return (...args: [organizationId: string, projectId: string, ...rest: unknown[]]) => {
        assertTenantClaim(
          scope,
          { organizationId: args[0], projectId: args[1] },
          `SigningService.${String(property)}`
        );
        return Reflect.apply(value, target, args);
      };
    },
  });
}
