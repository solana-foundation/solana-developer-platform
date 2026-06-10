import { afterEach, describe, expect, it, vi } from "vitest";
import type { SigningConfigRecord } from "@/services/adapters";
import {
  provisionCoinbaseCdpAccount,
  provisionPrivyWallet,
  provisionUtilaWallet,
} from "@/services/custody/provisioning";
import { type SigningRequestStore, SigningService } from "@/services/domain/signing.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

vi.mock("@/services/custody/provisioning", () => ({
  provisionCoinbaseCdpAccount: vi.fn(),
  provisionPrivyWallet: vi.fn(),
  provisionUtilaWallet: vi.fn(),
}));

const mockedProvisionPrivyWallet = vi.mocked(provisionPrivyWallet);
const mockedProvisionCoinbaseCdpAccount = vi.mocked(provisionCoinbaseCdpAccount);
const mockedProvisionUtilaWallet = vi.mocked(provisionUtilaWallet);

describe("signing.service provider reuse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the existing Privy root wallet when switching back to Privy", async () => {
    const orgId = "org_reuse_privy";
    const configId = "cust_privy_reuse";
    const wallet = createCustodyWallet(configId, "privy_wallet_1", "privy_wallet_pubkey");
    const configRecord = createConfigRecord({
      id: configId,
      orgId,
      provider: "privy",
      defaultWalletId: wallet.walletId,
    });

    const { service, configStore } = createService({
      configRecord,
      wallets: [wallet],
      envOverrides: {
        PRIVY_APP_ID: "privy-app-id",
        PRIVY_APP_SECRET: "privy-app-secret",
      },
    });

    const result = await service.initializePrivySigning(orgId, undefined, {});

    expect(result.walletId).toBe(wallet.walletId);
    expect(result.publicKey).toBe(wallet.publicKey);
    expect(result.configId).toBe(configId);
    expect(mockedProvisionPrivyWallet).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(configStore.upsert).toHaveBeenCalledWith(orgId, undefined, {
      provider: "privy",
      defaultWalletId: wallet.walletId,
    });
    expect(configStore.setDefaultConfig).toHaveBeenCalledWith(orgId, undefined, configId);
  });

  it("reuses the existing Coinbase root wallet when switching back to Coinbase", async () => {
    const orgId = "org_reuse_coinbase";
    const configId = "cust_coinbase_reuse";
    const wallet = createCustodyWallet(
      configId,
      "cdp_coinbase_wallet_id",
      "coinbase_wallet_pubkey"
    );
    const configRecord = createConfigRecord({
      id: configId,
      orgId,
      provider: "coinbase_cdp",
      defaultWalletId: wallet.walletId,
    });

    const { service, configStore } = createService({
      configRecord,
      wallets: [wallet],
      envOverrides: {
        COINBASE_CDP_API_KEY_ID: "coinbase-key-id",
        COINBASE_CDP_API_KEY_SECRET: "coinbase-key-secret",
        COINBASE_CDP_WALLET_SECRET: "coinbase-wallet-secret",
      },
    });

    const result = await service.initializeCoinbaseCdpSigning(orgId, undefined, {});

    expect(result.walletId).toBe(wallet.walletId);
    expect(result.publicKey).toBe(wallet.publicKey);
    expect(result.configId).toBe(configId);
    expect(mockedProvisionCoinbaseCdpAccount).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(configStore.upsert).toHaveBeenCalledWith(orgId, undefined, {
      provider: "coinbase_cdp",
      defaultWalletId: wallet.walletId,
    });
    expect(configStore.setDefaultConfig).toHaveBeenCalledWith(orgId, undefined, configId);
  });

  it("reuses the existing Utila root wallet when switching back to Utila", async () => {
    const orgId = "org_reuse_utila";
    const configId = "cust_utila_reuse";
    const wallet = createCustodyWallet(configId, "utila_wallet_1", "utila_wallet_pubkey");
    const configRecord = createConfigRecord({
      id: configId,
      orgId,
      provider: "utila",
      defaultWalletId: wallet.walletId,
    });

    const { service, configStore } = createService({
      configRecord,
      wallets: [wallet],
      envOverrides: {
        UTILA_SERVICE_ACCOUNT_EMAIL: "utila-service-account@example.com",
        UTILA_SERVICE_ACCOUNT_PRIVATE_KEY: "utila-private-key",
        UTILA_VAULT_ID: "vaults/utila_vault_1",
      },
    });

    const result = await service.initializeUtilaSigning(orgId, undefined, {});

    expect(result.walletId).toBe(wallet.walletId);
    expect(result.publicKey).toBe(wallet.publicKey);
    expect(result.configId).toBe(configId);
    expect(mockedProvisionUtilaWallet).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(configStore.upsert).toHaveBeenCalledWith(orgId, undefined, {
      provider: "utila",
      defaultWalletId: wallet.walletId,
    });
    expect(configStore.setDefaultConfig).toHaveBeenCalledWith(orgId, undefined, configId);
  });

  it("does not promote lifecycle-only providers to the default signer", async () => {
    const orgId = "org_lifecycle_default_guard";
    const anchorageConfigId = "cust_anchorage_lifecycle";
    const { service, configStore } = createService({
      configRecord: createConfigRecord({
        id: anchorageConfigId,
        orgId,
        provider: "anchorage",
        defaultWalletId: "anchorage_wallet_1",
      }),
      wallets: [],
      defaultConfigRecord: null,
    });

    configStore.upsert.mockResolvedValue(anchorageConfigId);

    await service.configureProvider(orgId, undefined, {
      provider: "anchorage",
      defaultWalletId: "anchorage_wallet_1",
    });

    expect(configStore.setDefaultConfig).not.toHaveBeenCalled();
  });

  it("replaces a lifecycle-only default when a signing provider is configured", async () => {
    const orgId = "org_promote_signing_default";
    const signingConfigId = "cust_privy_promoted";
    const lifecycleDefault = createConfigRecord({
      id: "cust_anchorage_default",
      orgId,
      provider: "anchorage",
      defaultWalletId: "anchorage_wallet_1",
    });
    const { service, configStore } = createService({
      configRecord: createConfigRecord({
        id: signingConfigId,
        orgId,
        provider: "privy",
        defaultWalletId: "privy_wallet_1",
      }),
      wallets: [],
      defaultConfigRecord: lifecycleDefault,
    });

    configStore.upsert.mockResolvedValue(signingConfigId);

    await service.configureProvider(orgId, undefined, {
      provider: "privy",
      defaultWalletId: "privy_wallet_1",
    });

    expect(configStore.setDefaultConfig).toHaveBeenCalledWith(orgId, undefined, signingConfigId);
  });
});

function createService(params: {
  configRecord: SigningConfigRecord;
  wallets: CustodyWallet[];
  envOverrides?: Partial<Env>;
  defaultConfigRecord?: SigningConfigRecord | null;
}): {
  service: SigningService;
  configStore: {
    findActive: ReturnType<typeof vi.fn>;
    listActive: ReturnType<typeof vi.fn>;
    findByProvider: ReturnType<typeof vi.fn>;
    findActiveByProvider: ReturnType<typeof vi.fn>;
    getDefaultConfig: ReturnType<typeof vi.fn>;
    setDefaultConfig: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    createWallet: ReturnType<typeof vi.fn>;
    getWallets: ReturnType<typeof vi.fn>;
    deactivateWalletIfNotLast: ReturnType<typeof vi.fn>;
    reactivateWallet: ReturnType<typeof vi.fn>;
  };
} {
  const configStore = {
    findActive: vi.fn().mockResolvedValue(null),
    listActive: vi.fn().mockResolvedValue([params.configRecord]),
    findByProvider: vi.fn().mockResolvedValue(params.configRecord),
    findActiveByProvider: vi.fn().mockResolvedValue(null),
    getDefaultConfig: vi.fn().mockResolvedValue(params.defaultConfigRecord ?? null),
    setDefaultConfig: vi.fn().mockResolvedValue(undefined),
    getById: vi.fn().mockResolvedValue(params.configRecord),
    upsert: vi.fn().mockResolvedValue(params.configRecord.id),
    createWallet: vi.fn(),
    getWallets: vi.fn().mockResolvedValue(params.wallets),
    deactivateWalletIfNotLast: vi.fn(),
    reactivateWallet: vi.fn(),
  };

  const signingStore: SigningRequestStore = {
    create: vi.fn(),
    findByIdOrExternal: vi.fn(),
    updateStatus: vi.fn(),
  };

  const env: Env = {
    HYPERDRIVE: {
      connectionString: "postgresql://sdp:sdp@127.0.0.1:5432/sdp",
    },
    CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ENVIRONMENT: "development",
    API_VERSION: "v1",
    ...params.envOverrides,
  } as Env;

  return {
    service: new SigningService(configStore as never, signingStore, env),
    configStore,
  };
}

function createConfigRecord(params: {
  id: string;
  orgId: string;
  provider: SigningConfigRecord["provider"];
  defaultWalletId: string;
}): SigningConfigRecord {
  return {
    id: params.id,
    organizationId: params.orgId,
    projectId: null,
    provider: params.provider,
    config: "encrypted-placeholder",
    defaultWalletId: params.defaultWalletId,
    status: "inactive",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function createCustodyWallet(configId: string, walletId: string, publicKey: string): CustodyWallet {
  return {
    id: `cwlt_${walletId}`,
    custodyConfigId: configId,
    walletId,
    publicKey,
    label: "Root",
    purpose: "root",
    status: "active",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}
