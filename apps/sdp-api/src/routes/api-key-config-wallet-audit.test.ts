import { SigningError } from "@sdp/custody/signing";
import { hashString } from "@sdp/payments/hash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { getLogger } from "@/runtime/logger";
import { createProviderWallet } from "@/services/domain/signing/provider-wallet-lifecycle";
import { CustodyConfigStore } from "@/services/stores/custody-config.store";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

vi.mock("@/services/domain/signing/provider-config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/domain/signing/provider-config")>()),
  parseConfigRecord: vi.fn(async () => ({ provider: "privy" })),
}));

vi.mock("@/services/domain/signing/provider-wallet-lifecycle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/services/domain/signing/provider-wallet-lifecycle")>()),
  createProviderWallet: vi.fn(async () => ({
    walletId: "privy_api_key_new",
    publicKey: "SysvarRent111111111111111111111111111111111",
  })),
}));

const org = "org_config_key_wallet_audit";
const project = "prj_config_key_wallet_audit";
const user = "usr_config_key_wallet_audit";
const apiKey = "key_config_key_wallet_audit";
const rawKey = "sk_test_config_key_wallet_audit";
const config = "cust_config_key_wallet_audit";
const originalFlag = env.PRIVY_BYOK_ENABLED;
const originalAppId = env.PRIVY_APP_ID;
const originalAppSecret = env.PRIVY_APP_SECRET;
const PUBLIC_KEY = "SysvarRent111111111111111111111111111111111";
const WALLET_ID = "privy_api_key_new";

async function createApiKey(name = "Config provisioned key") {
  return app.request(
    `/v1/projects/${project}/api-keys`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
        "X-Request-ID": "req_config_key_wallet_audit",
      },
      body: JSON.stringify({
        name,
        walletScope: "selected",
        provisionWallet: true,
        walletLabel: "API key wallet",
        walletPurpose: "transfer",
      }),
    },
    env
  );
}

async function rejectApiKeyTransaction() {
  const db = getDb(env);
  await db.execute(
    "ALTER TABLE api_keys ADD CONSTRAINT reject_created_key CHECK (name <> 'Rejected key') NOT VALID"
  );
  try {
    return await createApiKey("Rejected key");
  } finally {
    await db.execute("ALTER TABLE api_keys DROP CONSTRAINT reject_created_key");
  }
}

async function readAuditRows() {
  const records = await getDb(env).queryMany<{
    api_key_id: string;
    action: string;
    resource_type: string;
    resource_id: string;
    status: string;
    metadata: string;
  }>(
    "SELECT api_key_id, action, resource_type, resource_id, status, metadata FROM audit_logs WHERE organization_id = ? ORDER BY ledger_sequence",
    [org]
  );
  return records.map((row) => ({
    ...row,
    metadata: z.record(z.string(), z.json()).parse(JSON.parse(row.metadata)),
  }));
}

async function readProvisionedWallet() {
  return getDb(env).queryOne<{
    id: string;
    wallet_id: string;
    public_key: string;
    custody_config_id: string;
    purpose: string | null;
  }>(
    "SELECT id, wallet_id, public_key, custody_config_id, purpose FROM custody_wallets WHERE wallet_id = ?",
    [WALLET_ID]
  );
}

describe("legacy Config wallet provisioning for API keys", () => {
  beforeEach(async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = "config-key-audit-app";
    env.PRIVY_APP_SECRET = "config-key-audit-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    const db = getDb(env);
    await db.execute(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Config Key Audit', 'config-key-audit', 'enterprise', 'active')",
      [org]
    );
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'config-key-audit@example.test', 1, 'active')",
      [user]
    );
    await seedDefaultProjects(db, {
      organizationId: org,
      createdBy: user,
      members: [],
      ids: { sandbox: project, production: `${project}_production` },
    });
    const hash = await hashString(rawKey, env.API_KEY_PEPPER);
    await db.execute(
      `INSERT INTO api_keys (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
      VALUES (?, ?, ?, ?, 'Audit', 'sk_test_cfg', ?, 'api_admin', '["*"]', 'active')`,
      [apiKey, org, project, user, hash]
    );
    await seedCachedApiKey(env, hash, {
      id: apiKey,
      organizationId: org,
      projectId: project,
      role: "api_admin",
      permissions: ["*"],
      environment: "sandbox",
      rateLimitTier: "standard",
      allowedIps: null,
      signingWalletId: null,
      status: "active",
      expiresAt: null,
    });
    // Legacy Config branch: a scope default pointing at a custody config with
    // no Custody Connection anywhere in the scope.
    await db.execute(
      `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
      VALUES (?, ?, ?, 'privy', 'test', 'test', 'active')`,
      [config, org, project]
    );
    await db.execute(
      `INSERT INTO custody_scope_defaults (id, organization_id, project_id, default_custody_config_id, default_custody_connection_id)
      VALUES ('csd_config_key_wallet_audit', ?, ?, ?, NULL)`,
      [org, project, config]
    );
    vi.mocked(createProviderWallet).mockClear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.PRIVY_BYOK_ENABLED = originalFlag;
    env.PRIVY_APP_ID = originalAppId;
    env.PRIVY_APP_SECRET = originalAppSecret;
    await clearKVStores(env);
  });

  it("keeps a custody_wallet audit intent and outcome when the API-key transaction fails", async () => {
    const response = await rejectApiKeyTransaction();

    expect(response.status).toBe(500);
    const wallet = await readProvisionedWallet();
    expect(wallet).toMatchObject({ custody_config_id: config, purpose: "transfer" });
    const rows = await readAuditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      api_key_id: apiKey,
      action: "maintenance",
      resource_type: "audit_ledger",
      metadata: {
        auditPhase: "intent",
        target: {
          action: "create",
          resourceType: "custody_wallet",
          resourceId: wallet?.id,
          metadata: {
            event: "custody_wallet_created",
            projectId: project,
            provider: "privy",
            custodyConfigId: config,
            custodyWalletId: wallet?.id,
            creationReason: "api_key",
            setDefault: false,
          },
        },
      },
    });
    expect(rows[1]).toMatchObject({
      api_key_id: apiKey,
      action: "create",
      resource_type: "custody_wallet",
      resource_id: wallet?.id,
      status: "success",
      metadata: {
        auditPhase: "outcome",
        auditIntentId: rows[0]?.resource_id,
        event: "custody_wallet_created",
        result: "created",
        walletId: WALLET_ID,
        publicKey: PUBLIC_KEY,
        creationReason: "api_key",
      },
    });
    expect(
      await getDb(env).queryOne("SELECT id FROM api_keys WHERE name = 'Rejected key'")
    ).toBeNull();
  });

  it("reuses the durable unbound wallet on retry instead of provisioning another", async () => {
    expect((await rejectApiKeyTransaction()).status).toBe(500);
    expect(await readProvisionedWallet()).not.toBeNull();

    const response = await createApiKey();

    expect(response.status).toBe(201);
    const body = z
      .object({ data: z.object({ apiKey: z.object({ id: z.string() }) }) })
      .parse(await response.json());
    expect(createProviderWallet).toHaveBeenCalledTimes(1);
    expect(
      await getDb(env).queryMany("SELECT id FROM custody_wallets WHERE wallet_id = ?", [WALLET_ID])
    ).toHaveLength(1);
    expect(
      await getDb(env)
        .prepare("SELECT wallet_id FROM api_key_wallet_permissions WHERE api_key_id = ?")
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ wallet_id: WALLET_ID });
    expect(
      await getDb(env)
        .prepare("SELECT signing_wallet_id FROM api_keys WHERE id = ?")
        .bind(body.data.apiKey.id)
        .first()
    ).toEqual({ signing_wallet_id: WALLET_ID });
  });

  it("records a failure outcome when the provider rejects deterministically", async () => {
    vi.mocked(createProviderWallet).mockRejectedValueOnce(
      new SigningError("Provider rejected the wallet", "PROVIDER_NOT_CONFIGURED")
    );

    const response = await createApiKey();

    expect(response.status).toBe(400);
    expect(await readProvisionedWallet()).toBeNull();
    const rows = await readAuditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      action: "maintenance",
      resource_type: "audit_ledger",
      metadata: { auditPhase: "intent", target: { resourceType: "custody_wallet" } },
    });
    expect(rows[1]).toMatchObject({
      action: "create",
      resource_type: "custody_wallet",
      status: "failure",
      metadata: {
        auditPhase: "outcome",
        auditIntentId: rows[0]?.resource_id,
        result: "failed",
        reason: "provider_rejected",
      },
    });
  });

  it("leaves the intent unresolved when the provider result is ambiguous", async () => {
    vi.mocked(createProviderWallet).mockRejectedValueOnce(
      new SigningError("Provider connection lost", "NETWORK_ERROR")
    );
    const errorLog = vi.spyOn(getLogger(), "error");

    const response = await createApiKey();

    expect(response.status).toBe(400);
    expect(await readProvisionedWallet()).toBeNull();
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "maintenance",
      resource_type: "audit_ledger",
      metadata: { auditPhase: "intent", target: { resourceType: "custody_wallet" } },
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        custodyConfigId: config,
        provider: "privy",
        reason: "provider_result_unknown",
        auditIntentId: rows[0]?.resource_id,
      }),
      "custody_wallet_orphan_risk"
    );
  });

  it("leaves the intent unresolved with the provider wallet id when persistence fails", async () => {
    vi.spyOn(CustodyConfigStore.prototype, "createWallet").mockRejectedValueOnce(
      new Error("storage unavailable")
    );
    const errorLog = vi.spyOn(getLogger(), "error");

    const response = await createApiKey();

    expect(response.status).toBe(400);
    expect(await readProvisionedWallet()).toBeNull();
    const rows = await readAuditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "maintenance",
      resource_type: "audit_ledger",
      metadata: { auditPhase: "intent", target: { resourceType: "custody_wallet" } },
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        custodyConfigId: config,
        provider: "privy",
        reason: "persistence_failed",
        auditIntentId: rows[0]?.resource_id,
        walletId: WALLET_ID,
      }),
      "custody_wallet_orphan_risk"
    );
  });

  it("does not call the provider when audit admission fails", async () => {
    vi.spyOn(getDb(env), "lockedTransactionWithPostCommit").mockRejectedValueOnce(
      new Error("audit unavailable")
    );

    const response = await createApiKey();

    expect(response.status).toBe(500);
    expect(createProviderWallet).not.toHaveBeenCalled();
    expect(await readProvisionedWallet()).toBeNull();
    expect(await readAuditRows()).toEqual([]);
    expect(
      await getDb(env).queryOne("SELECT id FROM api_keys WHERE name = 'Config provisioned key'")
    ).toBeNull();
  });

  it("records the wallet intent and outcome around a successful provisioning", async () => {
    const response = await createApiKey();

    expect(response.status).toBe(201);
    const wallet = await readProvisionedWallet();
    expect(wallet).not.toBeNull();
    const rows = await readAuditRows();
    expect(rows).toHaveLength(3);
    expect(rows[0]?.metadata).toMatchObject({
      auditPhase: "intent",
      target: { resourceType: "custody_wallet", resourceId: wallet?.id },
    });
    expect(rows[1]).toMatchObject({
      action: "create",
      resource_type: "custody_wallet",
      resource_id: wallet?.id,
      status: "success",
      metadata: {
        auditPhase: "outcome",
        result: "created",
        walletId: WALLET_ID,
        publicKey: PUBLIC_KEY,
      },
    });
    expect(rows[2]).toMatchObject({
      action: "create",
      resource_type: "api_key",
      metadata: { signingWalletId: WALLET_ID, provisionedWallet: true },
    });
  });

  it("does not adopt wallets that were not provisioned for API keys", async () => {
    const db = getDb(env);
    await db.execute(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, purpose, status)
      VALUES ('cwlt_wallets_api_seed', ?, 'privy_wallets_api_seed', '${PUBLIC_KEY}', 'API key wallet', 'transfer', 'active')`,
      [config]
    );

    const response = await createApiKey();

    expect(response.status).toBe(201);
    expect(createProviderWallet).toHaveBeenCalledTimes(1);
    expect(
      await db.queryOne("SELECT id FROM custody_wallets WHERE wallet_id = 'privy_wallets_api_seed'")
    ).not.toBeNull();
    expect(await readProvisionedWallet()).not.toBeNull();
  });

  it("does not adopt a wallet already bound to another API key", async () => {
    const db = getDb(env);
    await db.execute(
      `INSERT INTO api_keys (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
      VALUES ('key_other_binding', ?, ?, ?, 'Other', 'sk_test_oth', 'other-hash', 'api_admin', '["*"]', 'active')`,
      [org, project, user]
    );
    await db.execute(
      `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, purpose, status)
      VALUES ('cwlt_bound_seed', ?, 'privy_bound_seed', '${PUBLIC_KEY}', 'API key wallet', 'transfer', 'active')`,
      [config]
    );
    await db.execute(
      `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
      VALUES ('akw_bound_seed', 'key_other_binding', 'privy_bound_seed', '["*"]')`
    );

    const response = await createApiKey();

    expect(response.status).toBe(201);
    expect(createProviderWallet).toHaveBeenCalledTimes(1);
    expect(
      await db.queryOne("SELECT id FROM custody_wallets WHERE wallet_id = 'privy_bound_seed'")
    ).not.toBeNull();
    expect(await readProvisionedWallet()).not.toBeNull();
  });
});
