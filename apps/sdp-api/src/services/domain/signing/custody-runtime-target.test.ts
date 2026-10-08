import type { CustodyProvider } from "@sdp/custody";
import type { FullSigningPort } from "@sdp/custody/signing";
import type { CustodyMode } from "@sdp/types";
import { PrivySigner } from "@solana/keychain-privy";
import { address } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import type { SigningConfigRecord } from "@/services/adapters";
import * as credentialSecretStore from "@/services/credential-secret-store";
import {
  CustodyRuntimeTargets,
  selectCustodyConnectionTarget,
} from "@/services/domain/signing/custody-runtime-target";
import { createSigningService } from "@/services/domain/signing.service";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import {
  insertTestCustodyConfigRow,
  insertTestCustodyScopeDefault,
  insertTestCustodyWalletRow,
  seedTestCustodyRows,
} from "@/test/helpers/custody";
import {
  seedTestPrivyConnection,
  type TestPrivyConnectionSeed,
} from "@/test/helpers/custody-connections";
import { custodyReleaseChannel } from "@/test/helpers/custody-release-channel";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const { mockCustodyReleaseChannels } = await import("@/test/helpers/custody-release-channel");
  return mockCustodyReleaseChannels(
    await importOriginal<typeof import("@sdp/types/release-channels")>()
  );
});

const ORGANIZATION_ID = "org_runtime_targets";
const PROJECT_ID = "prj_runtime_targets";
const USER_ID = "usr_runtime_targets";
const CONFIG_PUBLIC_KEY = "Vote111111111111111111111111111111111111111";
const CONNECTION_PUBLIC_KEY = "11111111111111111111111111111111";
const SECOND_CONNECTION_PUBLIC_KEY = "Stake11111111111111111111111111111111111111";

interface ConnectionSeed {
  id: string;
  credentialId: string;
  lastCheckStatus: TestPrivyConnectionSeed["lastCheckStatus"];
}

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

  it("admits an active non-selected Connection without reading credentials", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);
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

  it("rechecks Connection entitlement before cached generic and exact signer resolution", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, connection.id);
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await targets.admitRuntimeExecution({
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      custodyWalletId: `cwlt_${connection.id}`,
    });
    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
    expect(read).toHaveBeenCalledOnce();

    await setPrivyEntitlement(false);

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
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
    expect(await getProjectDefault()).toEqual({
      default_custody_config_id: config.id,
      default_custody_connection_id: connection.id,
    });
  });

  it("rechecks Config entitlement before generic and exact signer resolution", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    await setProjectDefault(config.id, null);
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONFIG_PUBLIC_KEY });
    await setPrivyEntitlement(false);

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
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

  it("signs with an exact non-default wallet under a non-selected Connection", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);
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

  it("resolves an exact unselected Connection without falling back to Config", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);
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

  it("returns the locked previous and selected defaults for an exact Connection switch", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);

    const result = await selectCustodyConnectionTarget(getDb(env), env, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: connection.id,
    });

    expect(result).toMatchObject({
      selection: {
        previousConfigId: config.id,
        previousConnectionId: null,
        selectedConfigId: config.id,
        selectedConnectionId: connection.id,
      },
    });
  });

  it("does not select a retained Connection after its provider entitlement is revoked", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);
    await setPrivyEntitlement(false);

    await expect(
      selectCustodyConnectionTarget(getDb(env), env, {
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        connectionId: connection.id,
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    expect(await getProjectDefault()).toEqual({
      default_custody_config_id: config.id,
      default_custody_connection_id: null,
    });
  });

  it("keeps an effective same-provider Config ahead of an unselected Connection", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({ kind: "config", config: { id: config.id } });
  });

  it.each(["success", "retry_unknown"] as const)(
    "keeps an active matching Project Config ahead of an unselected Connection with %s status",
    async (lastCheckStatus) => {
      const effectiveConfig = await seedConfig({ provider: "turnkey", projectId: PROJECT_ID });
      const matchingConfig = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
      await seedConnection({ ...DEFAULT_CONNECTION, lastCheckStatus });
      await setProjectDefault(effectiveConfig.id, null);
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.resolve({
          kind: "provider",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          provider: "privy",
        })
      ).resolves.toMatchObject({ kind: "config", config: { id: matchingConfig.id } });
    }
  );

  it("does not fall back to an Organization Config when matching Connection state is unusable", async () => {
    const effectiveConfig = await seedConfig({ provider: "turnkey", projectId: PROJECT_ID });
    const organizationConfig = await seedConfig({ provider: "privy", projectId: null });
    await seedConnection({ ...DEFAULT_CONNECTION, lastCheckStatus: "retry_unknown" });
    await setOrganizationDefault(organizationConfig.id);
    await setProjectDefault(effectiveConfig.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      message: "Custody Connection is unavailable",
    });
  });

  it("keeps a selected unusable Connection ahead of an active matching Config", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection({
      ...DEFAULT_CONNECTION,
      lastCheckStatus: "retry_unknown",
    });
    await setProjectDefault(config.id, connection.id);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({
      kind: "connection",
      connectionId: connection.id,
      isRuntimeAvailable: false,
    });
  });

  it("resolves the sole matching Connection when another provider is effective", async () => {
    const config = await seedConfig({ provider: "turnkey", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({
      kind: "connection",
      connectionId: connection.id,
      isRuntimeAvailable: true,
    });
  });

  it("requires selection when provider resolution finds multiple live Connections", async () => {
    const config = await seedConfig({ provider: "turnkey", projectId: PROJECT_ID });
    await seedConnection({
      id: "cconn_first",
      credentialId: "pcred_first",
      lastCheckStatus: "success",
    });
    await seedConnection({
      id: "cconn_second",
      credentialId: "pcred_second",
      lastCheckStatus: "success",
    });
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });

  it("ignores an unusable Connection when provider resolution has one usable target", async () => {
    const config = await seedConfig({ provider: "turnkey", projectId: PROJECT_ID });
    const connection = await seedConnection({
      id: "cconn_usable",
      credentialId: "pcred_usable",
      lastCheckStatus: "success",
    });
    await seedConnection({
      id: "cconn_unusable",
      credentialId: "pcred_unusable",
      lastCheckStatus: "retry_unknown",
    });
    await setProjectDefault(config.id, null);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.resolve({
        kind: "provider",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        provider: "privy",
      })
    ).resolves.toMatchObject({ kind: "connection", connectionId: connection.id });
  });

  it("supports exact unselected Connection and Config wallets while runtime is on", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, null);
    mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        connection.walletId,
        getConfigAdapter
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, config.walletId, getConfigAdapter)
    ).resolves.toMatchObject({ address: CONFIG_PUBLIC_KEY });
  });

  it("projects revoked entitlement without changing retained Config or Connection selection", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, connection.id);
    await setPrivyEntitlement(false);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.listWallets({
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        includeAllProviders: true,
      })
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          custodyConfigId: config.id,
          isRuntimeExecutionAllowed: false,
        }),
        expect.objectContaining({
          custodyConnectionId: connection.id,
          isDefaultProvider: true,
          isRuntimeExecutionAllowed: false,
        }),
      ])
    );
    await expect(
      targets.resolve({
        kind: "effective",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
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

  it("fails closed when the selected Connection is unusable", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection({
      ...DEFAULT_CONNECTION,
      lastCheckStatus: "retry_unknown",
    });
    await setProjectDefault(config.id, connection.id);
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(read).not.toHaveBeenCalled();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("fails closed when the selected Connection has no Provider Account fingerprint", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, connection.id);
    await getDb(env)
      .prepare("UPDATE custody_connections SET provider_account_fingerprint = NULL WHERE id = ?")
      .bind(connection.id)
      .run();
    const read = mockStoredCredentialRead();
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(read).not.toHaveBeenCalled();
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("does not fall back when a selected Connection loses its default wallet", async () => {
    const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(config.id, connection.id);
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `UPDATE custody_connections
           SET status = 'deactivated', deactivated_at = sdp_iso_now()
           WHERE id = ?`
        )
        .bind(connection.id),
      getDb(env)
        .prepare("DELETE FROM custody_wallets WHERE custody_connection_id = ?")
        .bind(connection.id),
    ]);
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("does not resolve a default Config owned by another scope", async () => {
    const foreignOrganizationId = "org_runtime_targets_foreign";
    const foreignConfigId = "cust_runtime_targets_foreign";
    await getDb(env).transaction(async (tx) => {
      await tx.execute(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, 'Foreign runtime targets', 'foreign-runtime-targets', 'individual', 'active')`,
        [foreignOrganizationId]
      );
      await insertTestCustodyConfigRow(tx, {
        id: foreignConfigId,
        organizationId: foreignOrganizationId,
        projectId: null,
        provider: "privy",
        configEncrypted: "encrypted",
        defaultWalletId: null,
        status: "active",
      });
    });
    await setProjectDefault(foreignConfigId, null);
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

    await expect(
      targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(getConfigAdapter).not.toHaveBeenCalled();
  });

  it("misses the stored adapter cache after Credential version rotation", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(null, connection.id);
    const read = mockStoredCredentialRead();
    const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);

    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
      getConfigAdapter
    );
    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
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

    await targets.getTransactionSigner(
      ORGANIZATION_ID,
      PROJECT_ID,
      connection.walletId,
      getConfigAdapter
    );
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("returns a redacted unavailable error when the Credential secret cannot be read", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(null, connection.id);
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

  it("is used by the production SigningService transaction-signer path", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(null, connection.id);
    mockStoredCredentialRead();

    await expect(
      createSigningService(env).getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        connection.walletId
      )
    ).resolves.toMatchObject({ address: CONNECTION_PUBLIC_KEY });
  });

  it("preserves a same-provider Connection on Config selection and clears it for another provider", async () => {
    const privyConfig = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
    const turnkeyConfig = await seedConfig({ provider: "turnkey", projectId: PROJECT_ID });
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(null, connection.id);
    const configStore = new CustodyConfigStore(getDb(env), env);

    await configStore.setDefaultConfig(ORGANIZATION_ID, PROJECT_ID, privyConfig.id);
    expect(await getProjectDefault()).toEqual({
      default_custody_config_id: privyConfig.id,
      default_custody_connection_id: connection.id,
    });

    const selection = await configStore.setDefaultConfig(
      ORGANIZATION_ID,
      PROJECT_ID,
      turnkeyConfig.id
    );
    expect(selection).toEqual({
      previousConfigId: privyConfig.id,
      previousConnectionId: connection.id,
      selectedConfigId: turnkeyConfig.id,
      selectedConnectionId: null,
    });
    expect(await getProjectDefault()).toEqual({
      default_custody_config_id: turnkeyConfig.id,
      default_custody_connection_id: null,
    });
  });

  it("passes the Connection request delay, else the environment delay, to the Privy signer", async () => {
    const connection = await seedConnection(DEFAULT_CONNECTION);
    await setProjectDefault(null, connection.id);
    await getDb(env).execute("UPDATE custody_connections SET request_delay_ms = 0 WHERE id = ?", [
      connection.id,
    ]);
    mockStoredCredentialRead();
    const createPrivySigner = vi.spyOn(PrivySigner, "create");
    const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);

    await expect(
      new CustodyRuntimeTargets(getDb(env), env, new Map()).getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        undefined,
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
      new CustodyRuntimeTargets(getDb(env), env, new Map()).getTransactionSigner(
        ORGANIZATION_ID,
        PROJECT_ID,
        undefined,
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
      await setProjectDefault(config.id, null);
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

  it.each([
    ["managed", "config"],
    ["byok", "connection"],
  ] as const)(
    "refuses the wallet-id signer for a %s wallet whose pair is out of channel",
    async (mode, owner) => {
      const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
      const connection = await seedConnection(DEFAULT_CONNECTION);
      await setProjectDefault(config.id, null);
      custodyReleaseChannel.outOfChannelMode = mode;
      const read = mockStoredCredentialRead();
      const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.getTransactionSigner(
          ORGANIZATION_ID,
          PROJECT_ID,
          owner === "config" ? config.walletId : connection.walletId,
          getConfigAdapter
        )
      ).rejects.toMatchObject(channelRefusal(mode));
      expect(read).not.toHaveBeenCalled();
      expect(getConfigAdapter).not.toHaveBeenCalled();
    }
  );

  it.each(["project", "organization"] as const)(
    "never resolves the %s Config in place of a selected out-of-channel Connection",
    async (configScope) => {
      const config = await seedConfig({
        provider: "privy",
        projectId: configScope === "project" ? PROJECT_ID : null,
      });
      const connection = await seedConnection(DEFAULT_CONNECTION);
      if (configScope === "project") {
        await setProjectDefault(config.id, connection.id);
      } else {
        await setOrganizationDefault(config.id);
        await setProjectDefault(null, connection.id);
      }
      custodyReleaseChannel.outOfChannelMode = "byok";
      const read = mockStoredCredentialRead();
      const getConfigAdapter = createConfigAdapterFactory(CONFIG_PUBLIC_KEY);
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.resolve({
          kind: "effective",
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
        })
      ).resolves.toMatchObject({ kind: "connection", connectionId: connection.id });
      await expect(
        targets.getTransactionSigner(ORGANIZATION_ID, PROJECT_ID, undefined, getConfigAdapter)
      ).rejects.toMatchObject(channelRefusal("byok"));
      expect(getConfigAdapter).not.toHaveBeenCalled();
      expect(read).not.toHaveBeenCalled();
    }
  );

  it.each(["managed", "byok"] as const)(
    "lists wallets whose pair is out of channel as not executable (%s out)",
    async (mode) => {
      const config = await seedConfig({ provider: "privy", projectId: PROJECT_ID });
      const connection = await seedConnection(DEFAULT_CONNECTION);
      await setProjectDefault(config.id, null);
      custodyReleaseChannel.outOfChannelMode = mode;
      const targets = new CustodyRuntimeTargets(getDb(env), env, new Map());

      await expect(
        targets.listWallets({
          organizationId: ORGANIZATION_ID,
          projectId: PROJECT_ID,
          includeAllProviders: true,
        })
      ).resolves.toEqual([
        {
          id: `cwlt_${config.id}`,
          custodyConfigId: config.id,
          provider: "privy",
          isDefaultProvider: true,
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
          isDefaultProvider: false,
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
    ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
  });
}

async function seedConfig(params: {
  provider: CustodyProvider;
  projectId: string | null;
}): Promise<{ id: string; walletId: string }> {
  const scopeSuffix = params.projectId === null ? "org" : params.projectId;
  const id = `cust_runtime_${params.provider}_${scopeSuffix}`;
  const walletId = `wallet_${params.provider}_${scopeSuffix}`;
  await seedTestCustodyRows(env, {
    configs: [
      {
        id,
        organizationId: ORGANIZATION_ID,
        projectId: params.projectId,
        provider: params.provider,
        configEncrypted: "encrypted",
        defaultWalletId: walletId,
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
    scopeDefaults: [],
  });
  return { id, walletId };
}

async function seedConnection(
  seed: ConnectionSeed
): Promise<{ id: string; credentialId: string; walletId: string }> {
  const walletId = `privy_${seed.id}`;
  await getDb(env).transaction((tx) =>
    seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: seed.id,
      credentialId: seed.credentialId,
      createdBy: USER_ID,
      stored: { storageBackend: "encrypted_db", encryptedSecretPayload: "ciphertext" },
      providerAccountFingerprint: `sha256:${seed.credentialId}`,
      lastCheckStatus: seed.lastCheckStatus,
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
      defaultCustodyWalletId: `cwlt_${seed.id}`,
    })
  );
  return { id: seed.id, credentialId: seed.credentialId, walletId };
}

async function setProjectDefault(
  configId: string | null,
  connectionId: string | null
): Promise<void> {
  await insertTestCustodyScopeDefault(getDb(env), {
    id: "csd_runtime_targets",
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    defaultCustodyConfigId: configId,
    defaultCustodyConnectionId: connectionId,
  });
}

async function setOrganizationDefault(configId: string): Promise<void> {
  await insertTestCustodyScopeDefault(getDb(env), {
    id: "csd_runtime_targets_org",
    organizationId: ORGANIZATION_ID,
    projectId: null,
    defaultCustodyConfigId: configId,
    defaultCustodyConnectionId: null,
  });
}

async function setPrivyEntitlement(entitled: boolean): Promise<void> {
  await getDb(env)
    .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
    .bind(JSON.stringify({ providerOverrides: { custody: { privy: entitled } } }), ORGANIZATION_ID)
    .run();
}

async function getProjectDefault(): Promise<{
  default_custody_config_id: string | null;
  default_custody_connection_id: string | null;
} | null> {
  return getDb(env)
    .prepare(
      `SELECT default_custody_config_id, default_custody_connection_id
       FROM custody_scope_defaults
       WHERE organization_id = ? AND project_id = ?`
    )
    .bind(ORGANIZATION_ID, PROJECT_ID)
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
