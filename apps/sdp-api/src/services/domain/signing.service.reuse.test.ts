import type { SigningConfigRecord } from "@/services/adapters";
import {
  provisionAnchorageWallet,
  provisionCoinbaseCdpAccount,
  provisionPrivyWallet,
} from "@/services/custody/provisioning";
import { type SigningRequestStore, SigningService } from "@/services/domain/signing.service";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/services/custody/provisioning", () => ({
  provisionAnchorageWallet: vi.fn(),
  provisionCoinbaseCdpAccount: vi.fn(),
  provisionPrivyWallet: vi.fn(),
}));

const mockedProvisionPrivyWallet = vi.mocked(provisionPrivyWallet);
const mockedProvisionAnchorageWallet = vi.mocked(provisionAnchorageWallet);
const mockedProvisionCoinbaseCdpAccount = vi.mocked(provisionCoinbaseCdpAccount);

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
  });

  it("reuses the existing Anchorage root wallet when switching back to Anchorage", async () => {
    const orgId = "org_reuse_anchorage";
    const configId = "cust_anchorage_reuse";
    const wallet = createCustodyWallet(
      configId,
      "anchorage_wallet_1",
      "anchorage_wallet_pubkey"
    );
    const configRecord = createConfigRecord({
      id: configId,
      orgId,
      provider: "anchorage",
      defaultWalletId: wallet.walletId,
    });

    const { service, configStore } = createService({
      configRecord,
      wallets: [wallet],
      envOverrides: {
        ANCHORAGE_API_ACCESS_KEY: "anchorage-access-key",
        ANCHORAGE_VAULT_ID: "vault_123",
        ANCHORAGE_NETWORK_ID: "SOL",
      },
    });

    const result = await service.initializeAnchorageSigning(orgId, undefined, {});

    expect(result.walletId).toBe(wallet.walletId);
    expect(result.publicKey).toBe(wallet.publicKey);
    expect(result.configId).toBe(configId);
    expect(mockedProvisionAnchorageWallet).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(configStore.upsert).toHaveBeenCalledWith(orgId, undefined, {
      provider: "anchorage",
      defaultWalletId: wallet.walletId,
    });
  });
});

function createService(params: {
  configRecord: SigningConfigRecord;
  wallets: CustodyWallet[];
  envOverrides?: Partial<Env>;
}): {
  service: SigningService;
  configStore: {
    findActive: ReturnType<typeof vi.fn>;
    findByProvider: ReturnType<typeof vi.fn>;
    getById: ReturnType<typeof vi.fn>;
    upsert: ReturnType<typeof vi.fn>;
    createWallet: ReturnType<typeof vi.fn>;
    getWallets: ReturnType<typeof vi.fn>;
  };
} {
  const configStore = {
    findActive: vi.fn().mockResolvedValue(null),
    findByProvider: vi.fn().mockResolvedValue(params.configRecord),
    getById: vi.fn().mockResolvedValue(params.configRecord),
    upsert: vi.fn().mockResolvedValue(params.configRecord.id),
    createWallet: vi.fn(),
    getWallets: vi.fn().mockResolvedValue(params.wallets),
  };

  const signingStore: SigningRequestStore = {
    create: vi.fn(),
    findByIdOrExternal: vi.fn(),
    updateStatus: vi.fn(),
  };

  const run = vi.fn().mockResolvedValue({ success: true });
  const bind = vi.fn().mockReturnValue({ run });
  const prepare = vi.fn().mockReturnValue({ bind });

  const env: Env = {
    DB: { prepare } as unknown as D1Database,
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
