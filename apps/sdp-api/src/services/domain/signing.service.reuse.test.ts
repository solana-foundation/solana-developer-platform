import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
import type { SigningConfigRecord } from "@/services/adapters";
import {
  provisionCoinbaseCdpAccount,
  provisionPrivyWallet,
  provisionUtilaWallet,
} from "@/services/custody/provisioning";
import { SigningService } from "@/services/domain/signing.service";
import * as providerAvailability from "@/services/provider-availability.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import { env as testEnv } from "@/test/helpers/env";
import type { Env } from "@/types/env";

vi.mock("@/services/custody/provisioning", () => ({
  provisionCoinbaseCdpAccount: vi.fn(),
  provisionPrivyWallet: vi.fn(),
  provisionUtilaWallet: vi.fn(),
}));

const mockedProvisionPrivyWallet = vi.mocked(provisionPrivyWallet);
const mockedProvisionCoinbaseCdpAccount = vi.mocked(provisionCoinbaseCdpAccount);
const mockedProvisionUtilaWallet = vi.mocked(provisionUtilaWallet);

const PROJECT_ID = "prj_signing_reuse";

describe("signing.service provider reuse", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses the existing Privy root wallet when Privy is initialized again", async () => {
    const orgId = "org_reuse_privy";
    const configId = "cust_privy_reuse";
    const wallet = createCustodyWallet(configId, "privy_wallet_1", "privy_wallet_pubkey");
    const configRecord = createConfigRecord({
      id: configId,
      orgId,
      provider: "privy",
    });

    const { service, configStore } = createService({
      configRecord,
      wallets: [wallet],
      envOverrides: {
        PRIVY_APP_ID: "privy-app-id",
        PRIVY_APP_SECRET: "privy-app-secret",
      },
    });

    const result = await service.initializePrivySigning(orgId, PROJECT_ID, {});

    expect(result.walletId).toBe(wallet.walletId);
    expect(result.publicKey).toBe(wallet.publicKey);
    expect(result.configId).toBe(configId);
    expect(mockedProvisionPrivyWallet).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(configStore.saveProviderConfig).toHaveBeenCalledWith({
      orgId,
      projectId: PROJECT_ID,
      provider: "privy",
      configJson: expect.objectContaining({ provider: "privy" }),
    });
  });

  it("reuses the existing Coinbase root wallet when Coinbase is initialized again", async () => {
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

    const result = await service.initializeCoinbaseCdpSigning(orgId, PROJECT_ID, {});

    expect(result.walletId).toBe(wallet.walletId);
    expect(result.publicKey).toBe(wallet.publicKey);
    expect(result.configId).toBe(configId);
    expect(mockedProvisionCoinbaseCdpAccount).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(configStore.saveProviderConfig).toHaveBeenCalledWith({
      orgId,
      projectId: PROJECT_ID,
      provider: "coinbase_cdp",
      configJson: expect.objectContaining({ provider: "coinbase_cdp" }),
    });
  });

  it("reuses the existing Utila root wallet when Utila is initialized again", async () => {
    const orgId = "org_reuse_utila";
    const configId = "cust_utila_reuse";
    const wallet = createCustodyWallet(configId, "utila_wallet_1", "utila_wallet_pubkey");
    const configRecord = createConfigRecord({
      id: configId,
      orgId,
      provider: "utila",
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

    const result = await service.initializeUtilaSigning(orgId, PROJECT_ID, {});

    expect(result.walletId).toBe(wallet.walletId);
    expect(result.publicKey).toBe(wallet.publicKey);
    expect(result.configId).toBe(configId);
    expect(mockedProvisionUtilaWallet).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(configStore.saveProviderConfig).toHaveBeenCalledWith({
      orgId,
      projectId: PROJECT_ID,
      provider: "utila",
      configJson: expect.objectContaining({ provider: "utila" }),
    });
  });
});

describe("signing.service custody provider enablement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a Managed custody operation through the organization-level provider check", async () => {
    const orgId = "org_signing_provider_disabled";
    const configRecord = createConfigRecord({
      id: "cust_privy_disabled",
      orgId,
      provider: "privy",
    });
    const { service, configStore } = createService({
      configRecord,
      wallets: [],
      envOverrides: { SDP_RELEASE_CHANNEL: "experimental" },
    });
    configStore.findActiveByProvider.mockResolvedValue(configRecord);
    const assertCustodyProviderEnabled = vi
      .spyOn(providerAvailability, "assertCustodyProviderEnabled")
      .mockRejectedValue(
        new AppError("FORBIDDEN", "Privy requires manual activation for this organization.")
      );

    await expect(
      service.createWallet(orgId, PROJECT_ID, { provider: "privy" })
    ).rejects.toMatchObject({
      name: "SigningError",
      code: "INVALID_REQUEST",
      message: "Privy requires manual activation for this organization.",
    });
    expect(assertCustodyProviderEnabled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ SDP_RELEASE_CHANNEL: "experimental" }),
      expect.anything(),
      orgId,
      "privy"
    );
    expect(configStore.createWallet).not.toHaveBeenCalled();
  });
});

function createService(params: {
  configRecord: SigningConfigRecord;
  wallets: CustodyWallet[];
  envOverrides?: Partial<Env>;
}): {
  service: SigningService;
  configStore: {
    listActive: ReturnType<typeof vi.fn>;
    findByProvider: ReturnType<typeof vi.fn>;
    findActiveByProvider: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    saveProviderConfig: ReturnType<typeof vi.fn>;
    createWallet: ReturnType<typeof vi.fn>;
    getWallets: ReturnType<typeof vi.fn>;
    deactivateWalletIfNotLast: ReturnType<typeof vi.fn>;
    reactivateWallet: ReturnType<typeof vi.fn>;
  };
} {
  const configStore = {
    listActive: vi.fn().mockResolvedValue([params.configRecord]),
    findByProvider: vi.fn().mockResolvedValue(params.configRecord),
    findActiveByProvider: vi.fn().mockResolvedValue(null),
    getById: vi.fn().mockResolvedValue(params.configRecord),
    saveProviderConfig: vi.fn().mockResolvedValue({ configId: params.configRecord.id }),
    createWallet: vi.fn(),
    getWallets: vi.fn().mockResolvedValue(params.wallets),
    deactivateWalletIfNotLast: vi.fn(),
    reactivateWallet: vi.fn(),
  };

  const env: Env = {
    DATABASE_URL: testEnv.DATABASE_URL,
    CUSTODY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    ENVIRONMENT: "development",
    API_VERSION: "v1",
    ...params.envOverrides,
  } as Env;

  return {
    service: new SigningService(configStore as never, env),
    configStore,
  };
}

function createConfigRecord(params: {
  id: string;
  orgId: string;
  provider: SigningConfigRecord["provider"];
}): SigningConfigRecord {
  return {
    id: params.id,
    organizationId: params.orgId,
    projectId: PROJECT_ID,
    provider: params.provider,
    config: "encrypted-placeholder",
    encryptionVersion: "sdp-custody-encryption-v1",
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
