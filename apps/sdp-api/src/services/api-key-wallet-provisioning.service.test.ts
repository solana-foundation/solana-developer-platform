import assert from "node:assert/strict";
import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, CustodyMode } from "@sdp/types";
import { Context } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { loadApiKeyWalletAuthorization } from "@/services/api-key-wallets.service";
import * as custodyProvisioning from "@/services/custody/provisioning";
import { SigningService } from "@/services/domain/signing.service";
import { getOrCreateDvpSettlementWallet } from "@/services/dvp/settlement-wallet";
import { custodyProviderNotInReleaseChannel } from "@/services/provider-availability.service";
import {
  insertTestCustodyConfigRow,
  insertTestCustodyScopeDefault,
  insertTestCustodyWalletRow,
  seedTestPrivyConnection,
  writeTestPrivyCredentialSecret,
} from "@/test/helpers/custody";
import {
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
} from "@/test/helpers/custody-connections";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";
import type { Env } from "@/types/env";
import { provisionApiKeyWallet } from "./api-key-wallet-provisioning.service";

const custodyReleaseChannel = vi.hoisted((): { outOfChannelMode: CustodyMode | null } => ({
  outOfChannelMode: null,
}));

vi.mock("@sdp/types/release-channels", async (importOriginal) => {
  const original = await importOriginal<typeof import("@sdp/types/release-channels")>();
  const isCustodyProviderInReleaseChannel: typeof original.isCustodyProviderInReleaseChannel = (
    releaseChannel,
    provider,
    mode
  ) =>
    mode !== custodyReleaseChannel.outOfChannelMode &&
    original.isCustodyProviderInReleaseChannel(releaseChannel, provider, mode);
  return { ...original, isCustodyProviderInReleaseChannel };
});

const provisionPrivyWalletMock = vi.spyOn(custodyProvisioning, "provisionPrivyWallet");
const ORGANIZATION_ID = "org_api_key_provisioning";
const PROJECT_ID = "prj_api_key_provisioning";
const CONNECTION_ID = "cconn_api_key_provisioning";
const FOREIGN_PROJECT_ID = "prj_api_key_provisioning_foreign";
const FOREIGN_CONNECTION_ID = "cconn_api_key_provisioning_foreign";
const CONFIG_ID = "cust_cfg_api_key_provisioning";
const USER_ID = "usr_api_key_provisioning";
const CREDENTIAL_ID = "pcred_api_key_provisioning";
const FOREIGN_CREDENTIAL_ID = "pcred_api_key_provisioning_foreign";
const API_KEY = { id: "key_api_key_provisioning", raw: "sk_test_api_key_provisioning" };
const CACHED_API_KEY: CachedApiKey = {
  id: API_KEY.id,
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
const auditContext = new Context<{ Bindings: Env }>(new Request("http://localhost/wallets"), {
  env,
});
auditContext.set("apiKey", CACHED_API_KEY);

const createConfigWalletMock = vi.spyOn(SigningService.prototype, "createWallet");
const originalEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;

describe("provisionApiKeyWallet", () => {
  beforeEach(async () => {
    custodyReleaseChannel.outOfChannelMode = null;
    env.CUSTODY_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    await seedTestDatabase(env);
    await clearKVStores(env);
    await seedFixture();
  });

  afterEach(async () => {
    env.CUSTODY_ENCRYPTION_KEY = originalEncryptionKey;
    vi.clearAllMocks();
    await clearKVStores(env);
  });

  it.each([undefined, CONNECTION_ID])(
    "uses the effective or exact Connection without changing defaults (%s)",
    async (connectionId) => {
      if (connectionId) {
        await getDb(env)
          .prepare(
            `UPDATE custody_scope_defaults
             SET default_custody_connection_id = NULL
             WHERE organization_id = ? AND project_id = ?`
          )
          .bind(ORGANIZATION_ID, PROJECT_ID)
          .run();
      }
      provisionPrivyWalletMock.mockResolvedValueOnce({
        walletId: connectionId ? "exact_api_key_wallet" : "effective_api_key_wallet",
        address: "Vote111111111111111111111111111111111111111",
      });

      const wallet = await provisionApiKeyWallet(getDb(env), env, {
        auditContext,
        creationReason: "api_key",
        organizationId: ORGANIZATION_ID,
        projectId: PROJECT_ID,
        connectionId,
        label: "API key wallet",
        purpose: "transfer",
      });

      expect(wallet.walletId).toBe(
        connectionId ? "privy_exact_api_key_wallet" : "privy_effective_api_key_wallet"
      );
      expect(
        await getDb(env)
          .prepare(
            `SELECT custody_connection_id, custody_config_id FROM custody_wallets WHERE id = ?`
          )
          .bind(wallet.id)
          .first()
      ).toEqual({ custody_connection_id: CONNECTION_ID, custody_config_id: null });
      expect(
        await getDb(env)
          .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
          .bind(CONNECTION_ID)
          .first()
      ).toEqual({ default_custody_wallet_id: "cwlt_api_key_provisioning_default" });
      expect(
        await getDb(env)
          .prepare(
            `SELECT default_custody_config_id, default_custody_connection_id
             FROM custody_scope_defaults WHERE organization_id = ? AND project_id = ?`
          )
          .bind(ORGANIZATION_ID, PROJECT_ID)
          .first()
      ).toEqual({
        default_custody_config_id: CONFIG_ID,
        default_custody_connection_id: connectionId ? null : CONNECTION_ID,
      });
    }
  );

  it("audits first-use DVP wallet creation with its initiating actor, and does not create on reuse", async () => {
    provisionPrivyWalletMock.mockResolvedValueOnce({
      walletId: "dvp_settlement",
      address: "Vote111111111111111111111111111111111111111",
    });
    const scope = { organizationId: ORGANIZATION_ID, projectId: PROJECT_ID };
    const first = await getOrCreateDvpSettlementWallet(env, auditContext, scope);
    expect(await getOrCreateDvpSettlementWallet(env, auditContext, scope)).toEqual(first);
    expect(provisionPrivyWalletMock).toHaveBeenCalledOnce();
    const audits = await getDb(env).queryMany<{
      api_key_id: string;
      resource_id: string;
      metadata: string;
    }>(
      "SELECT api_key_id, resource_id, metadata FROM audit_logs WHERE resource_type = 'custody_wallet' AND action = 'create'"
    );
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ api_key_id: API_KEY.id, resource_id: first.custodyWalletId });
    const metadata = z
      .object({
        result: z.string(),
        creationReason: z.string(),
        connectionId: z.string(),
      })
      .passthrough()
      .parse(JSON.parse(audits[0].metadata));
    expect(metadata).toMatchObject({
      result: "created",
      creationReason: "dvp_settlement_authority",
      connectionId: CONNECTION_ID,
    });
    expect(metadata).not.toHaveProperty("assignedSettlementAuthority");
  });

  it.each(["/v1/api-keys", `/v1/projects/${PROJECT_ID}/api-keys`])(
    "retains the wallet audit when later API-key creation fails through %s",
    async (path) => {
      provisionPrivyWalletMock.mockResolvedValueOnce({
        walletId: "partial_success",
        address: "Vote111111111111111111111111111111111111111",
      });
      const db = getDb(env);
      await db.execute(
        "ALTER TABLE api_keys ADD CONSTRAINT reject_created_key CHECK (name <> 'Rejected key') NOT VALID"
      );
      try {
        const response = await app.request(
          path,
          {
            method: "POST",
            headers: { Authorization: `Bearer ${API_KEY.raw}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              name: "Rejected key",
              walletScope: "selected",
              provisionWallet: { connectionId: CONNECTION_ID },
            }),
          },
          env
        );
        expect(response.status).toBe(500);
        const audit = await db.queryOne<{ resource_id: string; metadata: string }>(
          "SELECT resource_id, metadata FROM audit_logs WHERE resource_type = 'custody_wallet' AND action = 'create'"
        );
        assert(audit, "Expected wallet creation audit");
        const metadata = z
          .object({ result: z.string(), walletId: z.string() })
          .parse(JSON.parse(audit.metadata));
        expect(metadata).toMatchObject({
          result: "created",
          walletId: "privy_partial_success",
        });
        expect(
          await db.queryOne("SELECT id FROM custody_wallets WHERE id = ?", [audit.resource_id])
        ).toEqual({ id: audit.resource_id });
        expect(await db.queryOne("SELECT id FROM api_keys WHERE name = 'Rejected key'")).toBeNull();
      } finally {
        await db.execute("ALTER TABLE api_keys DROP CONSTRAINT reject_created_key");
      }
    }
  );

  it.each(["/v1/api-keys", `/v1/projects/${PROJECT_ID}/api-keys`])(
    "provisions and binds a Connection wallet through %s",
    async (path) => {
      await getDb(env)
        .prepare(
          `UPDATE custody_scope_defaults
           SET default_custody_connection_id = NULL
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(ORGANIZATION_ID, PROJECT_ID)
        .run();
      provisionPrivyWalletMock.mockResolvedValueOnce({
        walletId: "endpoint_api_key_wallet",
        address: "Vote111111111111111111111111111111111111111",
      });

      const response = await app.request(
        path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Connection key ${path}`,
            walletScope: "selected",
            provisionWallet: { connectionId: CONNECTION_ID },
          }),
        },
        env
      );

      expect(response.status).toBe(201);
      const walletAudit = await getDb(env).queryOne<{ api_key_id: string; metadata: string }>(
        "SELECT api_key_id, metadata FROM audit_logs WHERE resource_type = 'custody_wallet' AND action = 'create'"
      );
      assert(walletAudit, "Expected wallet creation audit");
      expect(walletAudit.api_key_id).toBe(API_KEY.id);
      const metadata = z
        .object({
          event: z.string(),
          creationReason: z.string(),
          connectionId: z.string(),
          walletId: z.string(),
          result: z.string(),
        })
        .parse(JSON.parse(walletAudit.metadata));
      expect(metadata).toMatchObject({
        event: "custody_wallet_created",
        creationReason: "api_key",
        connectionId: CONNECTION_ID,
        walletId: "privy_endpoint_api_key_wallet",
        result: "created",
      });
      const body = (await response.json()) as { data: { apiKey: { id: string } } };
      const binding = await getDb(env)
        .prepare(
          `SELECT p.wallet_id, w.id AS resolved_custody_wallet_id, w.custody_connection_id
           FROM api_key_wallet_permissions p
           JOIN custody_wallets w ON w.wallet_id = p.wallet_id
           WHERE p.api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first();
      expect(binding).toEqual({
        wallet_id: "privy_endpoint_api_key_wallet",
        resolved_custody_wallet_id: expect.any(String),
        custody_connection_id: CONNECTION_ID,
      });
      await expect(
        loadApiKeyWalletAuthorization(
          getDb(env),
          body.data.apiKey.id,
          ORGANIZATION_ID,
          PROJECT_ID,
          "privy_endpoint_api_key_wallet"
        )
      ).resolves.toMatchObject({
        walletScope: "selected",
        walletBindings: [
          {
            walletId: "privy_endpoint_api_key_wallet",
            custodyWalletId: binding?.resolved_custody_wallet_id,
          },
        ],
      });
      expect(
        await getDb(env)
          .prepare("SELECT default_custody_wallet_id FROM custody_connections WHERE id = ?")
          .bind(CONNECTION_ID)
          .first()
      ).toEqual({ default_custody_wallet_id: "cwlt_api_key_provisioning_default" });
      expect(
        await getDb(env)
          .prepare(
            `SELECT default_custody_connection_id
             FROM custody_scope_defaults
             WHERE organization_id = ? AND project_id = ?`
          )
          .bind(ORGANIZATION_ID, PROJECT_ID)
          .first()
      ).toEqual({ default_custody_connection_id: null });
    }
  );

  it.each(["/v1/api-keys", `/v1/projects/${PROJECT_ID}/api-keys`])(
    "rejects the obsolete top-level Connection selector through %s",
    async (path) => {
      const response = await app.request(
        path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Invalid Connection key ${path}`,
            walletScope: "selected",
            provisionWallet: true,
            connectionId: CONNECTION_ID,
          }),
        },
        env
      );

      expect(response.status).toBe(400);
      expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
      expect(createConfigWalletMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    ["missing", "/v1/api-keys", "missing_connection", null, 404],
    ["foreign", `/v1/projects/${PROJECT_ID}/api-keys`, FOREIGN_CONNECTION_ID, null, 404],
    ["out-of-channel", "/v1/api-keys", CONNECTION_ID, "byok", 403],
  ] as const)(
    "rejects %s Connection provisioning before Provider I/O",
    async (_, path, connectionId, outOfChannelMode, status) => {
      custodyReleaseChannel.outOfChannelMode = outOfChannelMode;
      const walletCountBefore = await getDb(env)
        .prepare("SELECT COUNT(*) AS count FROM custody_wallets")
        .first<{ count: number }>();

      const response = await app.request(
        path,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${API_KEY.raw}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: `Rejected Connection key ${connectionId}`,
            walletScope: "selected",
            provisionWallet: { connectionId },
          }),
        },
        env
      );

      expect(response.status).toBe(status);
      if (outOfChannelMode) {
        expect(await response.json()).toEqual({
          error: {
            code: "FORBIDDEN",
            message: custodyProviderNotInReleaseChannel("privy", outOfChannelMode).message,
          },
          meta: { requestId: expect.any(String) },
        });
      }
      expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
      expect(
        await getDb(env)
          .prepare("SELECT COUNT(*) AS count FROM custody_wallets")
          .first<{ count: number }>()
      ).toEqual(walletCountBefore);
    }
  );

  it("rejects an unusable exact Connection before Provider I/O", async () => {
    await getDb(env)
      .prepare("UPDATE provider_credentials SET status = 'failed_validation' WHERE id = ?")
      .bind(CREDENTIAL_ID)
      .run();

    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/api-keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Unusable Connection key",
          walletScope: "selected",
          provisionWallet: { connectionId: CONNECTION_ID },
        }),
      },
      env
    );

    expect(response.status).toBe(409);
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });

  it("binds an existing Connection wallet while its BYOK pair is out of channel", async () => {
    custodyReleaseChannel.outOfChannelMode = "byok";

    const response = await app.request(
      "/v1/api-keys",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Existing Connection wallet key",
          walletScope: "selected",
          signingWalletId: "privy_api_key_default",
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    const body = (await response.json()) as { data: { apiKey: { id: string } } };
    expect(
      await getDb(env)
        .prepare(
          `SELECT wallet_id
           FROM api_key_wallet_permissions
           WHERE api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ wallet_id: "privy_api_key_default" });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });

  it("provisions from the Config when it is the effective target and connectionId is omitted", async () => {
    const db = getDb(env);
    await db.execute(
      `UPDATE custody_scope_defaults
       SET default_custody_connection_id = NULL
       WHERE organization_id = ? AND project_id = ?`,
      [ORGANIZATION_ID, PROJECT_ID]
    );
    await insertTestCustodyWalletRow(db, {
      id: "cwlt_api_key_config_provisioned",
      owner: { kind: "config", custodyConfigId: CONFIG_ID },
      walletId: "para_api_key_config_provisioned",
      publicKey: "Vote111111111111111111111111111111111111111",
      label: null,
      purpose: null,
      status: "active",
    });
    createConfigWalletMock.mockResolvedValueOnce({
      id: "cwlt_api_key_config_provisioned",
      custodyConfigId: CONFIG_ID,
      walletId: "para_api_key_config_provisioned",
      publicKey: "Vote111111111111111111111111111111111111111",
      label: null,
      purpose: null,
      status: "active",
      createdAt: new Date().toISOString(),
    });

    const response = await app.request(
      `/v1/projects/${PROJECT_ID}/api-keys`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${API_KEY.raw}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name: "Config compatibility key",
          walletScope: "selected",
          provisionWallet: true,
        }),
      },
      env
    );

    expect(response.status).toBe(201);
    expect(createConfigWalletMock).toHaveBeenCalledWith(ORGANIZATION_ID, PROJECT_ID, {
      label: undefined,
      purpose: undefined,
    });
    const body = (await response.json()) as { data: { apiKey: { id: string } } };
    expect(
      await db
        .prepare(
          `SELECT wallet_id
           FROM api_key_wallet_permissions
           WHERE api_key_id = ?`
        )
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ wallet_id: "para_api_key_config_provisioned" });
    expect(provisionPrivyWalletMock).not.toHaveBeenCalled();
  });
});

async function seedFixture(): Promise<void> {
  const db = getDb(env);
  const keyHash = await hashString(API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, CACHED_API_KEY);
  await db.batch([
    db
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        ORGANIZATION_ID,
        "API key provisioning",
        "api-key-provisioning",
        "enterprise",
        "active"
      ),
    db
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
      .bind(USER_ID, "api-key-provisioning@example.com"),
  ]);
  await seedDefaultProjects(db, {
    organizationId: ORGANIZATION_ID,
    createdBy: USER_ID,
    members: [],
    ids: { sandbox: PROJECT_ID, production: FOREIGN_PROJECT_ID },
  });
  const stored = await writeTestPrivyCredentialSecret(env, {
    organizationId: ORGANIZATION_ID,
    credentialId: CREDENTIAL_ID,
    appId: "api-key-provisioning-app",
    appSecret: "api-key-provisioning-secret",
  });
  await db.transaction(async (tx) => {
    await tx.execute(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
          role, permissions, status)
       VALUES (?, ?, ?, ?, 'Admin', 'sk_test_api', ?, 'api_admin', '["*"]', 'active')`,
      [API_KEY.id, ORGANIZATION_ID, PROJECT_ID, USER_ID, keyHash]
    );
    await insertTestCustodyConfigRow(tx, {
      id: CONFIG_ID,
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      provider: "para",
      configEncrypted: "test",
      defaultWalletId: null,
      status: "active",
    });
    await seedTestPrivyConnection(tx, {
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      connectionId: CONNECTION_ID,
      credentialId: CREDENTIAL_ID,
      createdBy: USER_ID,
      stored,
      providerAccountFingerprint: `sha256:${CREDENTIAL_ID}`,
      lastCheckStatus: "success",
      wallets: [
        {
          id: "cwlt_api_key_provisioning_default",
          walletId: "privy_api_key_default",
          publicKey: "11111111111111111111111111111111",
          label: "Default",
          purpose: null,
          status: "active",
        },
      ],
      defaultCustodyWalletId: "cwlt_api_key_provisioning_default",
    });
    await insertTestStoredProviderCredential(tx, {
      id: FOREIGN_CREDENTIAL_ID,
      organizationId: ORGANIZATION_ID,
      projectId: FOREIGN_PROJECT_ID,
      provider: "privy",
      label: "Privy",
      stored,
      displayMetadata: {},
      status: "pending",
      credentialVersion: 1,
      rotatedFromProviderCredentialId: null,
      lastValidatedAt: null,
      deactivatedAt: null,
      createdBy: USER_ID,
    });
    await insertTestCustodyConnection(tx, {
      id: FOREIGN_CONNECTION_ID,
      organizationId: ORGANIZATION_ID,
      projectId: FOREIGN_PROJECT_ID,
      provider: "privy",
      credential: { id: FOREIGN_CREDENTIAL_ID, projectId: FOREIGN_PROJECT_ID },
      status: "pending",
      setupMetadata: {},
      providerAccountFingerprint: null,
      lastCheckStatus: null,
      lastCheckAt: null,
      lastCheckFailureCode: null,
      activatedAt: null,
      deactivatedAt: null,
      createdBy: USER_ID,
      createdAt: new Date().toISOString(),
    });
    await insertTestCustodyScopeDefault(tx, {
      id: "csd_api_key_provisioning",
      organizationId: ORGANIZATION_ID,
      projectId: PROJECT_ID,
      defaultCustodyConfigId: CONFIG_ID,
      defaultCustodyConnectionId: CONNECTION_ID,
    });
  });
}
