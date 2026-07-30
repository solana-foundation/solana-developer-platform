import { SigningError } from "@sdp/custody/signing";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as credentialSecretStore from "@/services/credential-secret-store";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { type SigningRequestStore, SigningService } from "@/services/domain/signing.service";
import * as providerAvailability from "@/services/provider-availability.service";
import {
  type CustodyConnectionRuntimeRecord,
  CustodyConnectionRuntimeStore,
  type CustodyWalletOwner,
} from "@/services/stores/custody-connection-runtime.store";
import type { Env } from "@/types/env";

const ORG_ID = "org_connection_runtime";
const PROJECT_ID = "prj_connection_runtime";
const CONNECTION_ID = "cconn_connection_runtime";
const CREDENTIAL_ID = "pcred_connection_runtime";

describe("SigningService stored-Credential Connection runtime", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the first Connection wallet ahead of a same-provider legacy Config", async () => {
    const connection = createConnection({
      status: "pending",
      lastCheckStatus: "success",
      defaultCustodyWalletId: null,
    });
    const connectionStore = createConnectionStore({
      connections: [
        connection,
        createConnection({
          id: "cconn_deactivated_history",
          status: "deactivated",
          credentialStatus: "deactivated",
          lastCheckStatus: "success",
        }),
      ],
      persistedWallet: {
        id: "cwlt_connection_runtime",
        walletId: "privy_wallet_created",
        publicKey: "11111111111111111111111111111111",
        label: "Treasury",
        purpose: "root",
        status: "active",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    });
    const configStore = createConfigStore();
    const service = createService(configStore, connectionStore);

    vi.spyOn(providerAvailability, "getProviderAvailability").mockResolvedValue({
      tier: "enterprise",
      providers: {
        custody: { privy: { entitled: true, configured: false, enabled: false } },
      },
    } as never);
    vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "encrypted_db",
      write: vi.fn(),
      read: vi.fn().mockResolvedValue({
        appId: "stored-app-id",
        appSecret: "stored-app-secret",
      }),
      destroyVersion: vi.fn(),
    });
    const provision = vi.spyOn(custodyProvisioning, "provisionPrivyWallet").mockResolvedValue({
      walletId: "wallet_created",
      address: "11111111111111111111111111111111",
    });

    const wallet = await service.createWallet(ORG_ID, PROJECT_ID, {
      provider: "privy",
      label: "Treasury",
      purpose: "root",
    });

    expect(provision).toHaveBeenCalledWith(
      expect.any(Object),
      {},
      {
        appId: "stored-app-id",
        appSecret: "stored-app-secret",
      }
    );
    expect(connectionStore.persistCreatedWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        providerCredentialId: CREDENTIAL_ID,
        setDefault: false,
        walletId: "privy_wallet_created",
      })
    );
    expect(configStore.createWallet).not.toHaveBeenCalled();
    expect(wallet).toMatchObject({
      id: "cwlt_connection_runtime",
      walletId: "privy_wallet_created",
    });
  });

  it.each([
    ["a conclusive provider rejection", "PROVIDER_NOT_CONFIGURED", false],
    ["an ambiguous network outcome", "NETWORK_ERROR", true],
  ] as const)("logs orphan risk only for %s", async (_description, code, shouldLog) => {
    const connectionStore = createConnectionStore({
      connections: [
        createConnection({
          status: "pending",
          lastCheckStatus: "success",
          defaultCustodyWalletId: null,
        }),
      ],
    });
    const service = createService(createConfigStore(), connectionStore);
    const provision = mockSuccessfulConnectionProvisioning();
    provision.mockRejectedValueOnce(new SigningError("provider failure", code));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      service.createWallet(ORG_ID, PROJECT_ID, {
        provider: "privy",
        requestId: "req_connection_runtime",
      })
    ).rejects.toMatchObject({ code: "PROVIDER_UNAVAILABLE" });

    expect(consoleError).toHaveBeenCalledTimes(shouldLog ? 1 : 0);
    if (shouldLog) {
      expect(consoleError).toHaveBeenCalledWith("custody_wallet_orphan_risk", {
        connectionId: CONNECTION_ID,
        provider: "privy",
        requestId: "req_connection_runtime",
        reason: "wallet_create_outcome_unknown",
      });
    }
  });

  it.each([
    ["a stale locked reread", new SigningError("Connection changed", "CONFLICT"), "CONFLICT"],
    ["a database failure", new Error("database unavailable"), "INTERNAL_ERROR"],
  ] as const)("maps %s after known Provider success to %s", async (_description, error, code) => {
    const connectionStore = createConnectionStore({
      connections: [
        createConnection({
          status: "pending",
          lastCheckStatus: "success",
          defaultCustodyWalletId: null,
        }),
      ],
    });
    connectionStore.persistCreatedWallet.mockRejectedValueOnce(error);
    const service = createService(createConfigStore(), connectionStore);
    mockSuccessfulConnectionProvisioning();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      service.createWallet(ORG_ID, PROJECT_ID, {
        provider: "privy",
        requestId: "req_persist_failure",
      })
    ).rejects.toMatchObject({ code });

    expect(consoleError).toHaveBeenCalledWith("custody_wallet_orphan_risk", {
      connectionId: CONNECTION_ID,
      provider: "privy",
      requestId: "req_persist_failure",
      providerWalletId: "wallet_created",
      reason: "wallet_persist_failed",
    });
  });

  it("does not inspect Connection state while the rollout flag is off", async () => {
    const connectionStore = createConnectionStore({
      connections: [
        createConnection({
          status: "pending",
          lastCheckStatus: "success",
          defaultCustodyWalletId: null,
        }),
      ],
    });
    const configStore = createConfigStore({ activeConfig: null });
    const service = createService(configStore, connectionStore, {
      PRIVY_BYOK_ENABLED: "false",
    });

    await expect(
      service.createWallet(ORG_ID, PROJECT_ID, {
        provider: "privy",
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    expect(connectionStore.listProjectConnections).not.toHaveBeenCalled();
  });

  it("blocks a Config switch when a Connection appears before the locked recheck", async () => {
    const execute = vi.fn();
    const queryOne = vi
      .fn()
      .mockResolvedValueOnce({ id: PROJECT_ID })
      .mockResolvedValueOnce({ id: "cust_legacy_privy", provider: "privy" })
      .mockResolvedValueOnce({ id: CONNECTION_ID });
    const tx = {
      prepare: vi.fn(),
      queryOne,
      queryMany: vi.fn(),
      execute,
    };
    const queryMany = vi.fn().mockResolvedValue([]);
    const store = new CustodyConnectionRuntimeStore({
      prepare: vi.fn(),
      queryOne: vi.fn(),
      queryMany,
      execute: vi.fn(),
      batch: vi.fn(),
      transaction: vi.fn(async (callback) => callback(tx)),
    } as never);

    expect(await store.listProjectConnections(ORG_ID, PROJECT_ID)).toEqual([]);
    await expect(
      store.selectConfig(ORG_ID, PROJECT_ID, "cust_legacy_privy", {
        clearConnection: true,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(queryOne.mock.calls[2]?.[0]).toContain("FOR UPDATE OF c, pc");
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not select a Config that has no active wallet", async () => {
    const execute = vi.fn();
    const tx = {
      prepare: vi.fn(),
      queryOne: vi
        .fn()
        .mockResolvedValueOnce({ id: PROJECT_ID })
        .mockResolvedValueOnce({
          id: "cust_legacy_local",
          provider: "local",
          default_wallet_id: null,
        })
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null),
      queryMany: vi.fn(),
      execute,
    };
    const store = new CustodyConnectionRuntimeStore({
      prepare: vi.fn(),
      queryOne: vi.fn(),
      queryMany: vi.fn(),
      execute: vi.fn(),
      batch: vi.fn(),
      transaction: vi.fn(async (callback) => callback(tx)),
    } as never);

    await expect(
      store.selectConfig(ORG_ID, PROJECT_ID, "cust_legacy_local", {
        clearConnection: true,
      })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(execute).not.toHaveBeenCalled();
  });

  it("resolves an explicitly addressed Connection wallet through its exact Credential", async () => {
    const connection = createConnection({
      status: "active",
      lastCheckStatus: "success",
      defaultCustodyWalletId: "cwlt_connection_runtime",
      defaultWalletId: "privy_wallet_runtime",
      defaultWalletPublicKey: "11111111111111111111111111111111",
    });
    const owner: CustodyWalletOwner = {
      kind: "connection",
      ownerId: connection.id,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      ownerStatus: "active",
      isSelected: true,
      connection,
      wallet: {
        id: "cwlt_connection_runtime",
        walletId: "privy_wallet_runtime",
        publicKey: "11111111111111111111111111111111",
        label: null,
        purpose: "root",
        status: "active",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    };
    const connectionStore = createConnectionStore({
      connections: [connection],
      walletOwner: owner,
    });
    const service = createService(createConfigStore(), connectionStore);

    vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "encrypted_db",
      write: vi.fn(),
      read: vi.fn().mockResolvedValue({
        appId: "stored-app-id",
        appSecret: "stored-app-secret",
      }),
      destroyVersion: vi.fn(),
    });

    const wallet = await service.getWalletById(ORG_ID, PROJECT_ID, "privy_wallet_runtime");
    const adapter = await service.getAdapter(ORG_ID, PROJECT_ID);

    expect(wallet).toMatchObject({
      walletId: "privy_wallet_runtime",
      provider: "privy",
      isDefaultProvider: true,
    });
    expect(wallet).not.toHaveProperty("custodyConfigId");
    expect(adapter.providerId).toBe("privy");
  });

  it("changes only the exact Connection wallet default without a provider call", async () => {
    const connection = createConnection({
      status: "active",
      lastCheckStatus: "success",
      defaultCustodyWalletId: "cwlt_old",
      defaultWalletId: "privy_wallet_old",
      defaultWalletPublicKey: "11111111111111111111111111111111",
    });
    const owner: CustodyWalletOwner = {
      kind: "connection",
      ownerId: connection.id,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      ownerStatus: "active",
      isSelected: true,
      connection,
      wallet: {
        id: "cwlt_new",
        walletId: "privy_wallet_new",
        publicKey: "11111111111111111111111111111111",
        label: null,
        purpose: null,
        status: "active",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    };
    const connectionStore = createConnectionStore({
      connections: [connection],
      walletOwner: owner,
    });
    const service = createService(createConfigStore(), connectionStore);
    const provision = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");

    await service.setDefaultWallet(ORG_ID, PROJECT_ID, "privy_wallet_new", "privy");

    expect(connectionStore.setDefaultWallet).toHaveBeenCalledWith(
      ORG_ID,
      PROJECT_ID,
      CONNECTION_ID,
      "cwlt_new"
    );
    expect(provision).not.toHaveBeenCalled();
  });

  it.each([
    ["keeps the existing default", false],
    ["requests the new wallet as default", true],
  ] as const)("%s when adding a wallet to an active Connection", async (_description, setDefault) => {
    const connection = createConnection({
      status: "active",
      lastCheckStatus: "success",
      defaultCustodyWalletId: "cwlt_existing",
      defaultWalletId: "privy_wallet_existing",
      defaultWalletPublicKey: "11111111111111111111111111111111",
    });
    const connectionStore = createConnectionStore({ connections: [connection] });
    const service = createService(createConfigStore(), connectionStore);
    mockSuccessfulConnectionProvisioning();

    await service.createWallet(ORG_ID, PROJECT_ID, {
      provider: "privy",
      setDefault,
    });

    expect(connectionStore.persistCreatedWallet).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionId: CONNECTION_ID,
        setDefault,
      })
    );
    expect(connectionStore.setDefaultWallet).not.toHaveBeenCalled();
  });

  it("uses the sole checked pending Connection when provider and target are omitted", async () => {
    const connection = createConnection({
      status: "pending",
      lastCheckStatus: "success",
      defaultCustodyWalletId: null,
    });
    const connectionStore = createConnectionStore({
      connections: [connection],
      selectedConnection: null,
    });
    const configStore = createConfigStore({ activeConfig: null });
    const service = createService(configStore, connectionStore);
    mockSuccessfulConnectionProvisioning();

    await service.createWallet(ORG_ID, PROJECT_ID, {});

    expect(connectionStore.persistCreatedWallet).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: CONNECTION_ID })
    );
    expect(configStore.createWallet).not.toHaveBeenCalled();
  });

  it.each([
    [
      "only deactivated history exists",
      [
        createConnection({
          status: "deactivated",
          credentialStatus: "deactivated",
        }),
      ],
    ],
    [
      "multiple live Connections exist",
      [createConnection({ id: "cconn_live_one" }), createConnection({ id: "cconn_live_two" })],
    ],
  ] as const)("%s fails closed without using a legacy Config", async (_description, connections) => {
    const connectionStore = createConnectionStore({ connections: [...connections] });
    const configStore = createConfigStore();
    const service = createService(configStore, connectionStore);

    await expect(
      service.createWallet(ORG_ID, PROJECT_ID, { provider: "privy" })
    ).rejects.toMatchObject({ code: "CONFLICT" });

    expect(configStore.findActiveByProvider).not.toHaveBeenCalled();
    expect(configStore.createWallet).not.toHaveBeenCalled();
  });

  it("rejects an active Connection whose latest Check is not successful", async () => {
    const connection = createConnection({
      status: "active",
      lastCheckStatus: "retry_unknown",
      defaultCustodyWalletId: "cwlt_connection_runtime",
      defaultWalletId: "privy_wallet_runtime",
      defaultWalletPublicKey: "11111111111111111111111111111111",
    });
    const owner: CustodyWalletOwner = {
      kind: "connection",
      ownerId: connection.id,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      ownerStatus: "active",
      isSelected: true,
      connection,
      wallet: {
        id: "cwlt_connection_runtime",
        walletId: "privy_wallet_runtime",
        publicKey: "11111111111111111111111111111111",
        label: null,
        purpose: "root",
        status: "active",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    };
    const connectionStore = createConnectionStore({
      connections: [connection],
      walletOwner: owner,
    });
    const service = createService(createConfigStore(), connectionStore);
    const read = vi.fn();
    vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "encrypted_db",
      write: vi.fn(),
      read,
      destroyVersion: vi.fn(),
    });

    await expect(service.getAdapter(ORG_ID, PROJECT_ID)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      service.getWalletById(ORG_ID, PROJECT_ID, "privy_wallet_runtime")
    ).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    ["returns a checked active Connection authority", "true", "success", true],
    ["hides a Connection authority while the flag is off", "false", "success", false],
    ["rejects an unusable exact Connection authority", "true", "retry_unknown", false],
  ] as const)("%s", async (_description, flag, lastCheckStatus, expected) => {
    const connection = createConnection({
      status: "active",
      lastCheckStatus,
      defaultCustodyWalletId: "cwlt_connection_runtime",
      defaultWalletId: "privy_wallet_runtime",
      defaultWalletPublicKey: "11111111111111111111111111111111",
    });
    const owner: CustodyWalletOwner = {
      kind: "connection",
      ownerId: connection.id,
      organizationId: ORG_ID,
      projectId: PROJECT_ID,
      provider: "privy",
      ownerStatus: "active",
      isSelected: true,
      connection,
      wallet: {
        id: "cwlt_connection_runtime",
        walletId: "privy_wallet_runtime",
        publicKey: "11111111111111111111111111111111",
        label: null,
        purpose: "root",
        status: "active",
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    };
    const connectionStore = createConnectionStore({
      connections: [connection],
      walletOwner: owner,
    });
    const service = createService(createConfigStore(), connectionStore, {
      PRIVY_BYOK_ENABLED: flag,
    });

    const wallet = await service.getWalletByPublicKey(
      ORG_ID,
      PROJECT_ID,
      "11111111111111111111111111111111"
    );

    expect(wallet?.walletId ?? null).toBe(expected ? "privy_wallet_runtime" : null);
    expect(connectionStore.findWalletOwnerByPublicKey).toHaveBeenCalledWith(
      ORG_ID,
      PROJECT_ID,
      "11111111111111111111111111111111",
      flag === "true"
    );
  });
});

function createService(
  configStore: ReturnType<typeof createConfigStore>,
  connectionStore: ReturnType<typeof createConnectionStore>,
  envOverrides: Partial<Env> = {}
) {
  const signingStore: SigningRequestStore = {
    create: vi.fn(),
    findByIdOrExternal: vi.fn(),
    updateStatus: vi.fn(),
  };

  return new SigningService(
    configStore as never,
    signingStore,
    {
      ENVIRONMENT: "development",
      API_VERSION: "v1",
      DATABASE_URL: "postgresql://unused",
      CREDENTIAL_SECRET_STORE_BACKEND: "encrypted_db",
      PRIVY_BYOK_ENABLED: "true",
      ...envOverrides,
    } as Env,
    connectionStore as never
  );
}

function createConfigStore(options: { activeConfig?: object | null } = {}) {
  const activeConfig =
    options.activeConfig === undefined
      ? {
          id: "cust_legacy_privy",
          organizationId: ORG_ID,
          projectId: PROJECT_ID,
          provider: "privy",
          config: "{}",
          encryptionVersion: "sdp-custody-encryption-v1",
          defaultWalletId: "privy_legacy_wallet",
          status: "active",
          createdAt: "2026-07-30T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
        }
      : options.activeConfig;

  return {
    findActive: vi.fn().mockResolvedValue(activeConfig),
    listActive: vi.fn().mockResolvedValue(activeConfig ? [activeConfig] : []),
    findByProvider: vi.fn().mockResolvedValue(activeConfig),
    findActiveByProvider: vi.fn().mockResolvedValue(activeConfig),
    getDefaultConfig: vi.fn().mockResolvedValue(activeConfig),
    setDefaultConfig: vi.fn(),
    getById: vi.fn().mockResolvedValue(activeConfig),
    upsert: vi.fn(),
    createWallet: vi.fn(),
    getWallets: vi.fn().mockResolvedValue([]),
    getWalletsForConfigs: vi.fn().mockResolvedValue(new Map()),
    deactivateWallet: vi.fn(),
    deactivateWalletIfNotLast: vi.fn(),
    reactivateWallet: vi.fn(),
  };
}

function createConnectionStore(options: {
  connections: CustodyConnectionRuntimeRecord[];
  selectedConnection?: CustodyConnectionRuntimeRecord | null;
  walletOwner?: CustodyWalletOwner;
  persistedWallet?: {
    id: string;
    walletId: string;
    publicKey: string;
    label: string | null;
    purpose: "root" | null;
    status: "active";
    createdAt: string;
  };
}) {
  return {
    listProjectConnections: vi.fn().mockResolvedValue(options.connections),
    getSelectedProjectConnection: vi
      .fn()
      .mockResolvedValue(
        options.selectedConnection === undefined
          ? (options.connections[0] ?? null)
          : options.selectedConnection
      ),
    findWalletOwner: vi.fn().mockResolvedValue(options.walletOwner ?? null),
    findWalletOwnerByPublicKey: vi.fn().mockResolvedValue(options.walletOwner ?? null),
    listConnectionWallets: vi.fn().mockResolvedValue([]),
    persistCreatedWallet: vi.fn().mockResolvedValue({
      wallet:
        options.persistedWallet ??
        ({
          id: "cwlt_connection_runtime",
          walletId: "privy_wallet_created",
          publicKey: "11111111111111111111111111111111",
          label: null,
          purpose: null,
          status: "active",
          createdAt: "2026-07-30T00:00:00.000Z",
        } as const),
      firstWallet: true,
    }),
    setDefaultWallet: vi.fn(),
    selectConnection: vi.fn(),
    selectConfig: vi.fn(),
  };
}

function mockSuccessfulConnectionProvisioning() {
  vi.spyOn(providerAvailability, "getProviderAvailability").mockResolvedValue({
    tier: "enterprise",
    providers: {
      custody: { privy: { entitled: true, configured: false, enabled: false } },
    },
  } as never);
  vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
    storageBackend: "encrypted_db",
    write: vi.fn(),
    read: vi.fn().mockResolvedValue({
      appId: "stored-app-id",
      appSecret: "stored-app-secret",
    }),
    destroyVersion: vi.fn(),
  });
  return vi.spyOn(custodyProvisioning, "provisionPrivyWallet").mockResolvedValue({
    walletId: "wallet_created",
    address: "11111111111111111111111111111111",
  });
}

function createConnection(
  overrides: Partial<CustodyConnectionRuntimeRecord>
): CustodyConnectionRuntimeRecord {
  return {
    id: CONNECTION_ID,
    organizationId: ORG_ID,
    projectId: PROJECT_ID,
    provider: "privy",
    providerCredentialId: CREDENTIAL_ID,
    defaultCustodyWalletId: null,
    defaultWalletId: null,
    defaultWalletPublicKey: null,
    status: "pending",
    lastCheckStatus: "success",
    credentialStatus: "active",
    credentialStorageBackend: "encrypted_db",
    credentialSecretRef: null,
    credentialSecretVersionRef: null,
    credentialEncryptedSecretPayload: "encrypted-payload",
    ...overrides,
  };
}
