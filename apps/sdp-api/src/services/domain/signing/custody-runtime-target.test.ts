import type { CustodyProvider } from "@sdp/custody";
import type { FullSigningPort } from "@sdp/custody/signing";
import {
  type CachedApiKey,
  CUSTODY_CONNECTION_LIFECYCLES,
  type CustodyConnectionCheckStatus,
  type CustodyConnectionLifecycle,
  type CustodyMode,
  type ProviderCredentialStatus,
} from "@sdp/types";
import { PrivySigner } from "@solana/keychain-privy";
import { address } from "@solana/kit";
import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import type { SigningConfigRecord } from "@/services/adapters";
import * as credentialSecretStore from "@/services/credential-secret-store";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { CustodyRuntimeTargets } from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { insertTestCustodyWalletRow, seedTestCustodyRows } from "@/test/helpers/custody";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  seedTestPrivyConnection,
  type TestPrivyConnectionSeed,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const ORGANIZATION_ID = "org_runtime_targets";
const PROJECT_ID = "prj_runtime_targets";
const OTHER_PROJECT_ID = "prj_runtime_targets_other";
const USER_ID = "usr_runtime_targets";
const CONFIG_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const CONNECTION_PUBLIC_KEY = "11111111111111111111111111111111";
const SECOND_CONNECTION_PUBLIC_KEY = "Stake11111111111111111111111111111111111111";

interface ConnectionSeed {
  id: string;
  credentialId: string;
  lastCheckStatus: TestPrivyConnectionSeed["lastCheckStatus"];
}

const UNFINISHED_INSTALLATION_FACTS = {
  pending: { credentialStatus: "pending", lastCheckStatus: null },
  checking: { credentialStatus: "pending", lastCheckStatus: "running" },
  failed: { credentialStatus: "failed_validation", lastCheckStatus: "failed" },
} as const satisfies Record<
  Exclude<CustodyConnectionLifecycle, "active" | "deactivated">,
  {
    credentialStatus: ProviderCredentialStatus;
    lastCheckStatus: CustodyConnectionCheckStatus | null;
  }
>;

const AUDIT_API_KEY: CachedApiKey = {
  id: "key_runtime_targets",
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const DEFAULT_CONNECTION: ConnectionSeed = {
  id: "cconn_runtime_targets",
  credentialId: "pcred_runtime_targets",
  lastCheckStatus: "success",
};

describe("CustodyRuntimeTargets", () => {
  const original = {
    appId: env.PRIVY_APP_ID,
    appSecret: env.PRIVY_APP_SECRET,
    apiBaseUrl: env.PRIVY_API_BASE_URL,
    requestDelayMs: env.PRIVY_REQUEST_DELAY_MS,
  };

  beforeEach(async () => {
    await seedTestDatabase(env);
    custodyReleaseChannel.outOfChannelMode = null;
    env.PRIVY_APP_ID = undefined;
    env.PRIVY_APP_SECRET = undefined;
    env.PRIVY_API_BASE_URL = "https://privy.runtime-targets.test/v1";
    env.PRIVY_REQUEST_DELAY_MS = "250";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(
        async () =>
          new Response(JSON.stringify({ address: CONNECTION_PUBLIC_KEY, chain_type: "solana" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
      )
    );
    await seedScope();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    env.PRIVY_APP_ID = original.appId;
    env.PRIVY_APP_SECRET = original.appSecret;
    env.PRIVY_API_BASE_URL = original.apiBaseUrl;
    env.PRIVY_REQUEST_DELAY_MS = original.requestDelayMs;
  });

  it("admits an exact active Config wallet without constructing a signer", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.admitRuntimeExecution({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId: `cwlt_${config.id}`,
      })
    ).resolves.toBeUndefined();
  });

  it("logs an unavailable exact Config admission without Provider access", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const custodyWalletId = `cwlt_${config.id}`;
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(custodyWalletId)
      .run();
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.admitRuntimeExecution({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "runtime_execution_unavailable" },
    });
    expect(warn).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
        targetKind: "config",
        targetId: config.id,
        custodyWalletId,
        reason: "runtime_execution_unavailable",
      },
      "custody_runtime_target_unavailable"
    );
  });

  it("exposes exact admission through the tenant-scoped SigningService", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const service = createSigningService(
      env,
      createTenantScope({ organizationId: ORGANIZATION_ID, projectId: PROJECT_ID })
    );

    await expect(
      service.admitRuntimeExecution(ORGANIZATION_ID, PROJECT_ID, `cwlt_${config.id}`)
    ).resolves.toBeUndefined();
    expect(() =>
      service.admitRuntimeExecution("org_foreign", PROJECT_ID, `cwlt_${config.id}`)
    ).toThrow(TenantScopeViolationError);
    expect(() =>
      service.getTransactionSignerForWalletRecord("org_foreign", PROJECT_ID, `cwlt_${config.id}`)
    ).toThrow(TenantScopeViolationError);
  });

  it("admits an active Connection wallet without reading credentials", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const read = mockStoredCredentialRead();
    const createPrivySigner = vi.spyOn(PrivySigner, "create");
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.admitRuntimeExecution({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId: `cwlt_${connection.id}`,
      })
    ).resolves.toBeUndefined();
    expect(read).not.toHaveBeenCalled();
    expect(createPrivySigner).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["config", "connection"] as const)(
    "rejects exact %s admission when the custody provider entitlement is revoked",
    async (owner) => {
      const wallet =
        owner === "config"
          ? await seedConfig({ provider: "privy", projectId: PROJECT_ID })
          : await seedConnection(DEFAULT_CONNECTION);
      await setPrivyEntitlement(false);
      const read = mockStoredCredentialRead();
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.admitRuntimeExecution({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          custodyWalletId: `cwlt_${wallet.id}`,
        })
      ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
      expect(read).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    [PROJECT_ID, "cwlt_missing"],
    ["prj_foreign", "cwlt_cconn_runtime_targets"],
  ])("hides a missing or foreign exact wallet", async (projectId, custodyWalletId) => {
    await seedConnection(DEFAULT_CONNECTION);
    const read = mockStoredCredentialRead();
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.admitRuntimeExecution({
        organizationId: ORGANIZATION_ID,
        projectId,
        custodyWalletId,
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(read).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        projectId,
        custodyWalletId,
        reason: "exact_wallet_not_found",
      },
      "custody_runtime_target_unavailable"
    );
  });

  it("preserves the exact signer's WALLET_NOT_FOUND compatibility code", async () => {
    const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        "cwlt_missing",
        createConfigAdapterFactory(CONFIG_PUBLIC_KEY)
      )
    ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
    expect(warn).toHaveBeenCalledWith(
      {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId: "cwlt_missing",
        reason: "exact_wallet_not_found",
      },
      "custody_runtime_target_unavailable"
    );
  });

  it.each(["wallet", "connection", "credential"] as const)(
    "reports an inactive exact Connection %s as runtime-unavailable",
    async (inactiveOwner) => {
      const connection = await seedConnection(DEFAULT_CONNECTION);
      if (inactiveOwner === "wallet") {
        await getDb(env)
          .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
          .bind(`cwlt_${connection.id}`)
          .run();
      } else if (inactiveOwner === "connection") {
        await getDb(env)
          .prepare(
            `UPDATE custody_connections
             SET status = 'deactivated', deactivated_at = sdp_iso_now()
             WHERE id = ?`
          )
          .bind(connection.id)
          .run();
      } else {
        await getDb(env)
          .prepare("UPDATE provider_credentials SET status = 'retired' WHERE id = ?")
          .bind(connection.credentialId)
          .run();
      }
      const read = mockStoredCredentialRead();
      const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.admitRuntimeExecution({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          custodyWalletId: `cwlt_${connection.id}`,
        })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        statusCode: 409,
        details: { reason: "runtime_execution_unavailable" },
      });
      expect(read).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        {
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "privy",
          targetKind: "connection",
          targetId: connection.id,
          custodyWalletId: `cwlt_${connection.id}`,
          reason: "connection_unusable",
        },
        "custody_runtime_target_unavailable"
      );
    }
  );

  it("rechecks an exact Connection immediately before reading credentials", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await targets.admitRuntimeExecution({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      custodyWalletId: `cwlt_${connection.id}`,
    });
    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'retired' WHERE id = ?")
      .bind(connection.credentialId)
      .run();

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      details: { reason: "runtime_execution_unavailable" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("rechecks Connection entitlement before cached exact signer resolution", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await targets.admitRuntimeExecution({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      custodyWalletId: `cwlt_${connection.id}`,
    });
    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
    expect(read).toHaveBeenCalledOnce();

    await setPrivyEntitlement(false);

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(read).toHaveBeenCalledOnce();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("rechecks Config entitlement before exact signer resolution", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${config.id}`,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONFIG_PUBLIC_KEY });
    await setPrivyEntitlement(false);

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${config.id}`,
        getConfigAdapter
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(getConfigAdapter).toHaveBeenCalledOnce();
  });

  it("signs with an exact secondary wallet of a Connection whose first wallet is inactive", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const custodyWalletId = `cwlt_${connection.id}_secondary`;
    await insertTestCustodyWalletRow(getDb(env), {
      id: custodyWalletId,
      owner: { kind: "connection", custodyConnectionId: connection.id },
      walletId: `${connection.walletId}_secondary`,
      publicKey: SECOND_CONNECTION_PUBLIC_KEY,
      label: null,
      purpose: null,
      status: "active",
    });
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(`cwlt_${connection.id}`)
      .run();
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ address: SECOND_CONNECTION_PUBLIC_KEY, chain_type: "solana" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );
    const read = mockStoredCredentialRead();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.admitRuntimeExecution({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId,
      })
    ).resolves.toBeUndefined();
    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        custodyWalletId,
        createConfigAdapterFactory(CONFIG_PUBLIC_KEY)
      )
    ).resolves.toMatchObject({ address: SECOND_CONNECTION_PUBLIC_KEY });
    expect(read).toHaveBeenCalledOnce();
  });

  it.each(["wallet", "config"] as const)(
    "reports an inactive exact Config %s as runtime-unavailable",
    async (inactiveOwner) => {
      const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
      await getDb(env)
        .prepare(
          inactiveOwner === "wallet"
            ? "UPDATE custody_wallets SET status = 'inactive' WHERE id = ?"
            : "UPDATE custody_configs SET status = 'inactive' WHERE id = ?"
        )
        .bind(inactiveOwner === "wallet" ? `cwlt_${config.id}` : config.id)
        .run();
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.admitRuntimeExecution({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          custodyWalletId: `cwlt_${config.id}`,
        })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        statusCode: 409,
        details: { reason: "runtime_execution_unavailable" },
      });
    }
  );

  it("keeps inactive wallet rows out of the public wallet-record resolver", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(`cwlt_${config.id}`)
      .run();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "wallet_record",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        custodyWalletId: `cwlt_${config.id}`,
      })
    ).resolves.toBeNull();
  });

  it("rechecks an exact Config wallet before constructing its signer", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await targets.admitRuntimeExecution({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      custodyWalletId: `cwlt_${config.id}`,
    });
    await getDb(env)
      .prepare("UPDATE custody_wallets SET status = 'inactive' WHERE id = ?")
      .bind(`cwlt_${config.id}`)
      .run();

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${config.id}`,
        getConfigAdapter
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "runtime_execution_unavailable" },
    });
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("rejects an exact signer whose address does not match the wallet row", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${config.id}`,
        createConfigAdapterFactory(CONNECTION_PUBLIC_KEY)
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      details: { reason: "runtime_execution_unavailable" },
    });
  });

  it("resolves an exact Connection without falling back to Config", async () => {
    await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "connection",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        connectionId: connection.id,
      })
    ).resolves.toMatchObject({
      kind: "connection",
      connectionId: connection.id,
      isRuntimeAvailable: true,
    });
    await expect(
      targets.resolve({
        kind: "connection",
        organizationId: ORGANIZATION_ID,
        projectId: "prj_foreign",
        connectionId: connection.id,
      })
    ).resolves.toBeNull();
  });

  it("creates a wallet under an active Connection", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const read = mockStoredCredentialRead();
    const provisionPrivyWallet = vi
      .spyOn(custodyProvisioning, "provisionPrivyWallet")
      .mockResolvedValueOnce({
        walletId: "runtime_targets_created",
        address: SECOND_CONNECTION_PUBLIC_KEY,
      });
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    const wallet = await targets.createConnectionWallet({
      auditContext: createAuditContext(),
      creationReason: "wallet_api",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: connection.id,
      label: "Created",
      purpose: "transfer",
    });

    expect(wallet).toEqual({
      id: expect.stringMatching(/^cwlt_/),
      custodyConnectionId: connection.id,
      isRuntimeExecutionAllowed: true,
      walletId: "privy_runtime_targets_created",
      publicKey: SECOND_CONNECTION_PUBLIC_KEY,
      label: "Created",
      purpose: "transfer",
      status: "active",
      createdAt: expect.any(String),
    });
    expect(read).toHaveBeenCalledOnce();
    expect(provisionPrivyWallet).toHaveBeenCalledOnce();
    expect(await getCustodyWalletRow(wallet.id)).toMatchObject({
      custody_connection_id: connection.id,
      custody_config_id: null,
      wallet_id: "privy_runtime_targets_created",
      status: "active",
    });
  });

  it.each(
    CUSTODY_CONNECTION_LIFECYCLES.filter(
      (lifecycle): lifecycle is UnavailableConnectionLifecycle => lifecycle !== "active"
    )
  )("refuses wallet creation under a %s Connection before any Provider call", async (lifecycle) => {
    const connection = await seedConnectionInLifecycle(lifecycle);
    const read = mockStoredCredentialRead();
    const provisionPrivyWallet = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");
    const walletRowsBefore = await getConnectionWalletRows(connection.id);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.createConnectionWallet({
        auditContext: createAuditContext(),
        creationReason: "wallet_api",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        connectionId: connection.id,
        label: "Refused",
        purpose: "transfer",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      message: "Custody Connection is unavailable",
    });
    expect(read).not.toHaveBeenCalled();
    expect(provisionPrivyWallet).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(await getConnectionWalletRows(connection.id)).toEqual(walletRowsBefore);
  });

  it("signs exact Connection and Config wallets of one project by record id", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${config.id}`,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONFIG_PUBLIC_KEY });
  });

  it("projects revoked entitlement on retained Config and Connection wallets", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setPrivyEntitlement(false);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.listWallets({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          custodyConfigId: config.id,
          isRuntimeExecutionAllowed: false,
        }),
        expect.objectContaining({
          custodyConnectionId: connection.id,
          isRuntimeExecutionAllowed: false,
        }),
      ])
    );
    await expect(
      targets.resolve({
        kind: "connection",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        connectionId: connection.id,
      })
    ).resolves.toMatchObject({ kind: "connection", connectionId: connection.id });
  });

  it.each([null, "root", "mint_authority", "freeze_authority", "fee_payer", "transfer"] as const)(
    "projects the supported wallet purpose %s",
    async (purpose) => {
      const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
      await getDb(env)
        .prepare("UPDATE custody_wallets SET purpose = ? WHERE id = ?")
        .bind(purpose, `cwlt_${config.id}`)
        .run();
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.findOperationalWalletById({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          custodyWalletId: `cwlt_${config.id}`,
        })
      ).resolves.toMatchObject({ purpose });
    }
  );

  it.each(["config", "connection"] as const)(
    "rejects an unknown wallet purpose from the %s projection",
    async (owner) => {
      const wallet =
        owner === "config"
          ? await seedConfig({ provider: "privy", projectId: PROJECT_ID })
          : await seedConnection(DEFAULT_CONNECTION);
      await getDb(env)
        .prepare("UPDATE custody_wallets SET purpose = 'unexpected' WHERE id = ?")
        .bind(`cwlt_${wallet.id}`)
        .run();
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.findOperationalWalletById({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          custodyWalletId: `cwlt_${wallet.id}`,
        })
      ).rejects.toMatchObject({ code: "INTERNAL_ERROR", statusCode: 500 });
    }
  );

  it("fails closed on an exact wallet of a pending Connection", async () => {
    const connection = await seedConnection({
      ...DEFAULT_CONNECTION,
      lastCheckStatus: "retry_unknown",
    });
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      details: { reason: "runtime_execution_unavailable" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("fails closed on an exact wallet of a Connection with no Provider Account fingerprint", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await getDb(env)
      .prepare("UPDATE custody_connections SET provider_account_fingerprint = NULL WHERE id = ?")
      .bind(connection.id)
      .run();
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      details: { reason: "runtime_execution_unavailable" },
    });
    expect(read).not.toHaveBeenCalled();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it.each(["config", "connection"] as const)(
    "never resolves a %s wallet from another project of the organization",
    async (owner) => {
      const wallet =
        owner === "config"
          ? await seedConfig({ provider: "privy", projectId: PROJECT_ID })
          : await seedConnection(DEFAULT_CONNECTION);
      const custodyWalletId = `cwlt_${wallet.id}`;
      const walletRowBefore = await getCustodyWalletRow(custodyWalletId);
      const read = mockStoredCredentialRead();
      const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
      vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.resolve({
          kind: "wallet_record",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          custodyWalletId,
        })
      ).resolves.toMatchObject({ kind: owner });
      await expect(
        targets.resolve({
          kind: "wallet_record",
          organizationId: ORGANIZATION_ID,
          projectId: OTHER_PROJECT_ID,
          custodyWalletId,
        })
      ).resolves.toBeNull();
      await expect(
        targets.resolve({
          kind: "wallet",
          organizationId: ORGANIZATION_ID,
          projectId: OTHER_PROJECT_ID,
          walletId: wallet.walletId,
        })
      ).resolves.toBeNull();
      await expect(
        targets.admitRuntimeExecution({
          organizationId: ORGANIZATION_ID,
          projectId: OTHER_PROJECT_ID,
          custodyWalletId,
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
      await expect(
        targets.getTransactionSignerForWalletRecord(
          ORGANIZATION_ID,
          OTHER_PROJECT_ID,
          custodyWalletId,
          getConfigAdapter
        )
      ).rejects.toMatchObject({ code: "WALLET_NOT_FOUND" });
      expect(getConfigAdapter).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
      expect(await getCustodyWalletRow(custodyWalletId)).toEqual(walletRowBefore);
    }
  );

  it("misses the stored adapter cache after Credential version rotation", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const custodyWalletId = `cwlt_${connection.id}`;
    const read = mockStoredCredentialRead();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);

    await targets.getTransactionSignerForWalletRecord(
      ORGANIZATION_ID,
      PROJECT_ID,
      custodyWalletId,
      getConfigAdapter
    );
    await targets.getTransactionSignerForWalletRecord(
      ORGANIZATION_ID,
      PROJECT_ID,
      custodyWalletId,
      getConfigAdapter
    );
    expect(read).toHaveBeenCalledOnce();

    await getDb(env)
      .prepare(
        `UPDATE provider_credentials
         SET credential_version = credential_version + 1
         WHERE id = ?`
      )
      .bind(connection.credentialId)
      .run();

    await targets.getTransactionSignerForWalletRecord(
      ORGANIZATION_ID,
      PROJECT_ID,
      custodyWalletId,
      getConfigAdapter
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns a redacted unavailable error when the Credential secret cannot be read", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    const read = vi.fn().mockRejectedValue(new Error("raw secret backend error"));
    vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
      storageBackend: "encrypted_db",
      write: vi.fn(),
      read,
      destroyVersion: vi.fn(),
      predictFirstVersionRef: vi.fn(() => null),
    });
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        createConfigAdapterFactory(CONFIG_PUBLIC_KEY)
      )
    ).rejects.toMatchObject({
      code: "PROVIDER_UNAVAILABLE",
      statusCode: 503,
      message: "Custody credential is temporarily unavailable",
    });
  });

  it("is used by the production SigningService exact transaction-signer path", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    mockStoredCredentialRead();

    await expect(
      createSigningService(env).getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
  });

  it("passes the Connection request delay, else the environment delay, to the Privy signer", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await getDb(env).execute("UPDATE custody_connections SET request_delay_ms = 0 WHERE id = ?", [
      connection.id,
    ]);
    mockStoredCredentialRead();
    const createPrivySigner = vi.spyOn(PrivySigner, "create");
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);

    await expect(
      new CustodyRuntimeTargets(getDb(env), env, new Map()).getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
    expect(createPrivySigner).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestDelayMs: 0 })
    );

    await getDb(env).execute(
      "UPDATE custody_connections SET request_delay_ms = NULL WHERE id = ?",
      [connection.id]
    );
    await expect(
      new CustodyRuntimeTargets(getDb(env), env, new Map()).getTransactionSignerForWalletRecord(
        ORGANIZATION_ID,
        PROJECT_ID,
        `cwlt_${connection.id}`,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
    expect(createPrivySigner).toHaveBeenLastCalledWith(
      expect.objectContaining({ requestDelayMs: 250 })
    );
  });

  it.each([
    ["managed", "config"],
    ["byok", "connection"],
  ] as const)(
    "refuses exact admission of a %s wallet whose pair is out of channel",
    async (mode, owner) => {
      const wallet =
        owner === "config"
          ? await seedConfig({ provider: "privy", projectId: PROJECT_ID })
          : await seedConnection(DEFAULT_CONNECTION);
      custodyReleaseChannel.outOfChannelMode = mode;
      const read = mockStoredCredentialRead();
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.admitRuntimeExecution({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          custodyWalletId: `cwlt_${wallet.id}`,
        })
      ).rejects.toMatchObject(channelRefusal(mode));
      expect(read).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["managed", "config"],
    ["byok", "connection"],
  ] as const)(
    "refuses the record-path signer for a %s wallet whose pair is out of channel",
    async (mode, owner) => {
      const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
      const connection = await seedConnection(DEFAULT_CONNECTION);
      const targetId = owner === "config" ? config.id : connection.id;
      const custodyWalletId = `cwlt_${targetId}`;
      custodyReleaseChannel.outOfChannelMode = mode;
      const read = mockStoredCredentialRead();
      const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => {});
      const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.getTransactionSignerForWalletRecord(
          ORGANIZATION_ID,
          PROJECT_ID,
          custodyWalletId,
          getConfigAdapter
        )
      ).rejects.toMatchObject(channelRefusal(mode));
      expect(read).not.toHaveBeenCalled();
      expect(getConfigAdapter).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        {
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "privy",
          targetKind: owner,
          targetId,
          custodyWalletId,
          reason: "not_in_release_channel",
        },
        "custody_runtime_target_unavailable"
      );
    }
  );

  it.each(["managed", "byok"] as const)(
    "lists wallets whose pair is out of channel as not executable (%s out)",
    async (mode) => {
      const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
      const connection = await seedConnection(DEFAULT_CONNECTION);
      custodyReleaseChannel.outOfChannelMode = mode;
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.listWallets({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
        })
      ).resolves.toEqual([
        {
          id: `cwlt_${config.id}`,
          custodyConfigId: config.id,
          provider: "privy",
          isRuntimeExecutionAllowed: mode !== "managed",
          walletId: config.walletId,
          publicKey: CONFIG_PUBLIC_KEY,
          label: null,
          purpose: null,
          status: "active",
          createdAt: expect.any(String),
        },
        {
          id: `cwlt_${connection.id}`,
          custodyConnectionId: connection.id,
          provider: "privy",
          isRuntimeExecutionAllowed: mode !== "byok",
          walletId: connection.walletId,
          publicKey: CONNECTION_PUBLIC_KEY,
          label: null,
          purpose: null,
          status: "active",
          createdAt: expect.any(String),
        },
      ]);
    }
  );
});

function channelRefusal(mode: CustodyMode) {
  return {
    code: "FORBIDDEN",
    statusCode: 403,
    message: custodyProviderNotInReleaseChannel("privy", mode).message,
    details: { reason: "custody_provider_not_in_release_channel" },
  };
}

async function seedScope(): Promise<void> {
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Runtime targets', 'runtime-targets', 'individual', 'active')`
      )
      .bind(ORGANIZATION_ID),
    getDb(env)
      .prepare(
        `INSERT INTO users (id, email, email_verified, status)
         VALUES (?, 'runtime-targets@example.com', 1, 'active')`
      )
      .bind(USER_ID),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: OTHER_PROJECT_ID },
  });
}

async function seedConfig(params: {
  provider: CustodyProvider;
  projectId: string;
}): Promise<{ id: string; walletId: string }> {
  const id = `cust_runtime_${params.provider}_${params.projectId}`;
  const walletId = `wallet_${params.provider}_${params.projectId}`;
  await seedTestCustodyRows(env, {
    configs: [
      {
        id,
        organizationId: ORGANIZATION_ID,
        projectId: params.projectId,
        provider: params.provider,
        configEncrypted: "encrypted",
        status: "active",
      },
    ],
    wallets: [
      {
        id: `cwlt_${id}`,
        owner: { kind: "config", custodyConfigId: id },
        walletId,
        publicKey: CONFIG_PUBLIC_KEY,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  });
  return { id, walletId };
}

async function seedConnection(
  seed: ConnectionSeed
): Promise<{ id: string; credentialId: string; walletId: string }> {
  const walletId = `privy_${seed.id}`;
  const connection = {
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    connectionId: seed.id,
    credentialId: seed.credentialId,
    createdBy: USER_ID,
    stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
    providerAccountFingerprint: `sha256:${seed.credentialId}`,
    wallets: [
      {
        id: `cwlt_${seed.id}`,
        walletId,
        publicKey: CONNECTION_PUBLIC_KEY,
        label: null,
        purpose: null,
        status: "active",
      },
    ],
  } satisfies Omit<
    Extract<TestPrivyConnectionSeed, { lastCheckStatus: "retry_unknown" }>,
    "lastCheckStatus"
  >;
  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(
      tx,
      seed.lastCheckStatus === "success"
        ? { ...connection, lastCheckStatus: "success", defaultCustodyWalletId: `cwlt_${seed.id}` }
        : { ...connection, lastCheckStatus: "retry_unknown" }
    )
  );
  return { id: seed.id, credentialId: seed.credentialId, walletId };
}

async function setPrivyEntitlement(entitled: boolean): Promise<void> {
  await getDb(env)
    .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
    .bind(JSON.stringify({ providerOverrides: { custody: { privy: entitled } } }), ORGANIZATION_ID)
    .run();
}

type UnavailableConnectionLifecycle = Exclude<CustodyConnectionLifecycle, "active">;

/**
 * Seed a Connection in a lifecycle other than `active` exactly as the product leaves
 * it there: an unfinished installation owns no wallet, and a deactivated Connection
 * keeps the wallets it owned while active.
 * @param lifecycle - The lifecycle the Connection is in.
 * @returns The Connection's ID.
 */
async function seedConnectionInLifecycle(
  lifecycle: UnavailableConnectionLifecycle
): Promise<{ id: string }> {
  switch (lifecycle) {
    case "pending":
    case "checking":
    case "failed": {
      const installation = UNFINISHED_INSTALLATION_FACTS[lifecycle];
      const id = `cconn_runtime_targets_${lifecycle}`;
      const credentialId = `pcred_runtime_targets_${lifecycle}`;
      await getDb(env).transaction(async (tx) => {
        await insertTestStoredProviderCredential(tx, {
          id: credentialId,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "privy",
          label: "Privy",
          stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
          displayMetadata: {},
          status: installation.credentialStatus,
          credentialVersion: 1,
          rotatedFromProviderCredentialId: null,
          lastValidatedAt: null,
          deactivatedAt: null,
          createdBy: USER_ID,
        });
        await insertTestCustodyConnection(tx, {
          id,
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "privy",
          credential: { id: credentialId, projectId: PROJECT_ID },
          status: lifecycle,
          setupMetadata: {},
          providerAccountFingerprint: null,
          lastCheckStatus: installation.lastCheckStatus,
          lastCheckAt: installation.lastCheckStatus === null ? null : new Date().toISOString(),
          lastCheckFailureCode: null,
          activatedAt: null,
          deactivatedAt: null,
          createdBy: USER_ID,
          createdAt: new Date().toISOString(),
        });
      });
      return { id };
    }
    case "deactivated": {
      const connection = await seedConnection(DEFAULT_CONNECTION);
      await getDb(env).execute(
        `UPDATE custody_connections
         SET status = 'deactivated', deactivated_at = sdp_iso_now()
         WHERE id = ?`,
        [connection.id]
      );
      return { id: connection.id };
    }
    default: {
      const unhandled: never = lifecycle;
      throw new Error(`Unhandled Connection lifecycle: ${String(unhandled)}`);
    }
  }
}

/**
 * Every wallet row owned by one Connection, by ID.
 * @param connectionId - The owning Connection.
 * @returns The Connection's wallet rows.
 */
async function getConnectionWalletRows(connectionId: string): Promise<Record<string, unknown>[]> {
  return getDb(env).queryMany(
    "SELECT * FROM custody_wallets WHERE custody_connection_id = ? ORDER BY id",
    [connectionId]
  );
}

/**
 * An API-key request context for the wallet-creation audit intent.
 * @returns The audit context.
 */
function createAuditContext(): Context<{ Bindings: Env }> {
  const auditContext = new Context<{ Bindings: Env }>(new Request("http://localhost/v1/wallets"), {
    env,
  });
  auditContext.set("apiKey", AUDIT_API_KEY);
  return auditContext;
}

async function getCustodyWalletRow(
  custodyWalletId: string
): Promise<Record<string, unknown> | null> {
  return getDb(env)
    .prepare("SELECT * FROM custody_wallets WHERE id = ?")
    .bind(custodyWalletId)
    .first();
}

function mockStoredCredentialRead() {
  const read = vi.fn().mockResolvedValue({
    appId: "stored-app-id",
    appSecret: "stored-app-secret",
  });
  vi.spyOn(credentialSecretStore, "createCredentialSecretStore").mockReturnValue({
    storageBackend: "encrypted_db",
    write: vi.fn(),
    read,
    destroyVersion: vi.fn(),
    predictFirstVersionRef: vi.fn(() => null),
  });
  return read;
}

function createConfigAdapterFactory(signerAddress: string) {
  const adapter: FullSigningPort = {
    providerId: "privy",
    getPublicKey: vi.fn(async () => address(CONFIG_PUBLIC_KEY)),
    getTransactionSigner: vi.fn(async () => ({
      address: address(signerAddress),
      signTransactions: vi.fn(async () => []),
    })),
  };

  return vi.fn(async (_orgId: string, _config: SigningConfigRecord) => adapter);
}
