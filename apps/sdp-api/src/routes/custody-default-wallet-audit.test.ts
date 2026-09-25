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
    walletId: "privy_config_new",
    publicKey: "SysvarRent111111111111111111111111111111111",
  })),
}));

const org = "org_default_audit";
const project = "prj_default_audit";
const user = "usr_default_audit";
const apiKey = "key_default_audit";
const rawKey = "sk_test_default_audit";
const config = "cust_default_audit";
const connection = "cconn_default_audit";
const originalFlag = env.PRIVY_BYOK_ENABLED;
const originalAppId = env.PRIVY_APP_ID;
const originalAppSecret = env.PRIVY_APP_SECRET;

async function changeDefault(owner: "connection" | "config", suffix = "b") {
  return app.request(
    "/v1/wallets/default-wallet",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
        "X-Request-ID": "req_default_wallet_audit",
      },
      body: JSON.stringify({ walletId: `privy_${owner}_${suffix}` }),
    },
    env
  );
}

async function createConfigWallet(body: Record<string, unknown>) {
  return app.request(
    "/v1/wallets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
        "X-Request-ID": "req_default_wallet_audit",
      },
      body: JSON.stringify({ provider: "privy", label: "Created", ...body }),
    },
    env
  );
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

async function readDefault(owner: "connection" | "config") {
  return getDb(env).queryOne<{ wallet_id: string }>(
    owner === "connection"
      ? "SELECT default_custody_wallet_id AS wallet_id FROM custody_connections WHERE id = ?"
      : "SELECT default_wallet_id AS wallet_id FROM custody_configs WHERE id = ?",
    [owner === "connection" ? connection : config]
  );
}

describe("default wallet audit admission", () => {
  beforeEach(async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = "default-audit-app";
    env.PRIVY_APP_SECRET = "default-audit-secret";
    await seedTestDatabase(env);
    await clearKVStores(env);
    const db = getDb(env);
    await db.execute(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Audit', 'default-audit', 'enterprise', 'active')",
      [org]
    );
    await db.execute(
      "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'audit@example.test', 1, 'active')",
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
      VALUES (?, ?, ?, ?, 'Audit', 'sk_test_def', ?, 'api_admin', '["*"]', 'active')`,
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
    await db.execute(
      `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
      VALUES (?, ?, ?, 'privy', 'test', 'test', 'active')`,
      [config, org, project]
    );
    await db.execute(
      `INSERT INTO custody_scope_defaults (id, organization_id, project_id, default_custody_config_id)
      VALUES ('csd_default_audit', ?, ?, ?)`,
      [org, project, config]
    );
    await db.execute(
      `INSERT INTO provider_credentials (id, organization_id, project_id, provider, label, scope, source, storage_backend, status, created_by)
      VALUES ('pcred_default_audit', ?, ?, 'privy', 'Test', 'project', 'runtime', 'runtime_env', 'active', ?)`,
      [org, project, user]
    );
    await db.execute(
      `INSERT INTO custody_connections (id, organization_id, project_id, provider, scope, provider_credential_id, provider_credential_scope_key, status, created_by)
      VALUES (?, ?, ?, 'privy', 'project', 'pcred_default_audit', ?, 'pending', ?)`,
      [connection, org, project, project, user]
    );
    for (const owner of ["connection", "config"] as const) {
      for (const suffix of ["a", "b"]) {
        await db.execute(
          `INSERT INTO custody_wallets (id, custody_config_id, custody_connection_id, wallet_id, public_key, status)
          VALUES (?, ?, ?, ?, ?, 'active')`,
          [
            `cwlt_${owner}_${suffix}`,
            owner === "config" ? config : null,
            owner === "connection" ? connection : null,
            `privy_${owner}_${suffix}`,
            suffix === "a"
              ? "11111111111111111111111111111111"
              : "So11111111111111111111111111111111111111112",
          ]
        );
      }
    }
    await db.execute(
      "UPDATE custody_configs SET default_wallet_id = 'privy_config_a' WHERE id = ?",
      [config]
    );
    await db.execute(
      `UPDATE custody_connections SET default_custody_wallet_id = 'cwlt_connection_a',
      status = 'active', last_check_status = 'success', last_check_at = sdp_iso_now(),
      provider_account_fingerprint = 'sha256:default-audit', activated_at = sdp_iso_now() WHERE id = ?`,
      [connection]
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    env.PRIVY_BYOK_ENABLED = originalFlag;
    env.PRIVY_APP_ID = originalAppId;
    env.PRIVY_APP_SECRET = originalAppSecret;
    await clearKVStores(env);
  });

  it.each(["connection", "config"] as const)(
    "does not change %s default if audit admission fails",
    async (owner) => {
      vi.spyOn(getDb(env), "lockedTransactionWithPostCommit").mockRejectedValueOnce(
        new Error("audit unavailable")
      );

      const response = await changeDefault(owner);

      expect(response.status).toBe(500);
      expect(await readDefault(owner)).toEqual({
        wallet_id: owner === "connection" ? "cwlt_connection_a" : "privy_config_a",
      });
    }
  );

  it.each(["connection", "config"] as const)(
    "records the exact %s change with its initiating API key",
    async (owner) => {
      const response = await changeDefault(owner);

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        data: { defaultWalletId: `privy_${owner}_b` },
      });
      const records = await getDb(env).queryMany<{
        api_key_id: string;
        metadata: string;
      }>(
        "SELECT api_key_id, metadata FROM audit_logs WHERE organization_id = ? ORDER BY ledger_sequence",
        [org]
      );
      const rows = records.map((row) => ({
        ...row,
        metadata: z.record(z.string(), z.json()).parse(JSON.parse(row.metadata)),
      }));
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ api_key_id: apiKey, metadata: { auditPhase: "intent" } });
      expect(rows[1]).toMatchObject({
        api_key_id: apiKey,
        metadata: {
          auditPhase: "outcome",
          auditIntentId: expect.any(String),
          event: "default_wallet_changed",
          ownerKind: owner,
          projectId: project,
          previousCustodyWalletId: `cwlt_${owner}_a`,
          custodyWalletId: `cwlt_${owner}_b`,
          previousWalletId: `privy_${owner}_a`,
          walletId: `privy_${owner}_b`,
        },
      });
      expect(JSON.stringify(rows)).not.toContain(rawKey);
      expect(JSON.stringify(rows)).not.toContain("default-audit-secret");
    }
  );

  it.each(["connection", "config"] as const)(
    "preserves confirmed %s success when its audit outcome fails",
    async (owner) => {
      const db = getDb(env);
      const writeAudit = db.lockedTransactionWithPostCommit?.bind(db);
      if (!writeAudit) throw new Error("Test database must support audit ledger writes");
      vi.spyOn(db, "lockedTransactionWithPostCommit")
        .mockImplementationOnce(writeAudit)
        .mockRejectedValueOnce(new Error("outcome storage unavailable"));

      expect((await changeDefault(owner)).status).toBe(200);
      expect(await readDefault(owner)).toEqual({
        wallet_id: owner === "connection" ? "cwlt_connection_b" : "privy_config_b",
      });
      expect(
        await db.queryMany(
          "SELECT id FROM audit_logs WHERE metadata::jsonb->>'auditPhase' = 'intent'"
        )
      ).toHaveLength(1);
      expect(
        await db.queryMany(
          "SELECT id FROM audit_logs WHERE metadata::jsonb->>'auditPhase' = 'outcome'"
        )
      ).toHaveLength(0);
    }
  );

  it.each(["connection", "config"] as const)(
    "does not attribute the same %s transition to concurrent requests twice",
    async (owner) => {
      const responses = await Promise.all([changeDefault(owner), changeDefault(owner)]);

      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const events = await getDb(env).queryMany<{ event: string }>(
        "SELECT metadata::jsonb->>'event' AS event FROM audit_logs WHERE metadata::jsonb->>'auditPhase' = 'outcome' ORDER BY ledger_sequence"
      );
      expect(events.map((row) => row.event).sort()).toEqual([
        "default_wallet_changed",
        "default_wallet_selection_unchanged",
      ]);
    }
  );

  it("leaves the intent unresolved when COMMIT confirmation is lost", async () => {
    const db = getDb(env);
    const transact = db.transaction.bind(db);
    vi.spyOn(db, "transaction").mockImplementationOnce(async (callback) => {
      await transact(callback);
      throw new Error("lost COMMIT acknowledgement");
    });

    expect((await changeDefault("connection")).status).toBe(500);
    expect(await readDefault("connection")).toEqual({ wallet_id: "cwlt_connection_b" });
    const phases = await db.queryMany<{ phase: string }>(
      "SELECT metadata::jsonb->>'auditPhase' AS phase FROM audit_logs"
    );
    expect(phases).toEqual([{ phase: "intent" }]);
  });

  it("records a Config default promoted during wallet creation like a default change", async () => {
    const response = await createConfigWallet({ setDefault: true });

    expect(response.status).toBe(201);
    const body = z
      .object({ data: z.object({ wallet: z.object({ id: z.string() }) }) })
      .parse(await response.json());
    const custodyWalletId = body.data.wallet.id;
    expect(await readDefault("config")).toEqual({ wallet_id: "privy_config_new" });
    const rows = await readAuditRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      api_key_id: apiKey,
      metadata: {
        auditPhase: "intent",
        target: {
          action: "update",
          resourceType: "custody_config",
          resourceId: config,
          metadata: {
            event: "default_wallet_change_started",
            ownerKind: "config",
            provider: "privy",
            custodyWalletId,
            projectId: project,
          },
        },
      },
    });
    expect(rows[1]).toMatchObject({
      api_key_id: apiKey,
      action: "update",
      resource_type: "custody_config",
      resource_id: config,
      status: "success",
      metadata: {
        auditPhase: "outcome",
        auditIntentId: rows[0]?.resource_id,
        event: "default_wallet_changed",
        ownerKind: "config",
        projectId: project,
        previousCustodyWalletId: "cwlt_config_a",
        custodyWalletId,
        previousWalletId: "privy_config_a",
        walletId: "privy_config_new",
      },
    });
  });

  it("creates a Config wallet without setDefault behind a custody_wallet audit intent and outcome", async () => {
    const response = await createConfigWallet({});

    expect(response.status).toBe(201);
    const body = z
      .object({ data: z.object({ wallet: z.record(z.string(), z.unknown()) }) })
      .parse(await response.json());
    expect(Object.keys(body.data.wallet).sort()).toEqual(
      [
        "createdAt",
        "custodyConfigId",
        "id",
        "isRuntimeExecutionAllowed",
        "label",
        "publicKey",
        "purpose",
        "status",
        "walletId",
      ].sort()
    );
    expect(body.data.wallet).toMatchObject({
      custodyConfigId: config,
      walletId: "privy_config_new",
      label: "Created",
      status: "active",
    });
    expect(await readDefault("config")).toEqual({ wallet_id: "privy_config_a" });
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
          resourceId: body.data.wallet.id,
          metadata: {
            event: "custody_wallet_created",
            projectId: project,
            provider: "privy",
            custodyConfigId: config,
            custodyWalletId: body.data.wallet.id,
            creationReason: "wallet_api",
            setDefault: false,
          },
        },
      },
    });
    expect(rows[1]).toMatchObject({
      api_key_id: apiKey,
      action: "create",
      resource_type: "custody_wallet",
      resource_id: body.data.wallet.id,
      status: "success",
      metadata: {
        auditPhase: "outcome",
        auditIntentId: rows[0]?.resource_id,
        event: "custody_wallet_created",
        result: "created",
        walletId: "privy_config_new",
        publicKey: "SysvarRent111111111111111111111111111111111",
      },
    });
  });

  it("does not create or promote a Config wallet if audit admission fails", async () => {
    vi.mocked(createProviderWallet).mockClear();
    vi.spyOn(getDb(env), "lockedTransactionWithPostCommit")
      .mockRejectedValueOnce(new Error("audit unavailable"))
      .mockRejectedValueOnce(new Error("audit unavailable"));
    const errorSchema = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

    const response = await createConfigWallet({ setDefault: true });
    const selection = await changeDefault("config");

    expect(response.status).toBe(500);
    expect(response.status).toBe(selection.status);
    expect(errorSchema.parse(await response.json()).error).toEqual(
      errorSchema.parse(await selection.json()).error
    );
    expect(await readDefault("config")).toEqual({ wallet_id: "privy_config_a" });
    expect(
      await getDb(env).queryMany("SELECT id FROM custody_wallets WHERE wallet_id = ?", [
        "privy_config_new",
      ])
    ).toEqual([]);
    expect(await readAuditRows()).toEqual([]);
    expect(createProviderWallet).not.toHaveBeenCalled();
  });

  it("logs the provisioned wallet as an orphan risk when the Config disappears", async () => {
    const db = getDb(env);
    vi.mocked(createProviderWallet).mockImplementationOnce(async () => {
      await db.execute("DELETE FROM custody_scope_defaults WHERE default_custody_config_id = ?", [
        config,
      ]);
      await db.execute("UPDATE custody_configs SET default_wallet_id = NULL WHERE id = ?", [
        config,
      ]);
      await db.execute("DELETE FROM custody_wallets WHERE custody_config_id = ?", [config]);
      await db.execute("DELETE FROM custody_configs WHERE id = ?", [config]);
      return {
        walletId: "privy_config_orphan",
        publicKey: "SysvarRent111111111111111111111111111111111",
      };
    });
    const errorLog = vi.spyOn(getLogger(), "error");

    const response = await createConfigWallet({ setDefault: true });

    expect(response.status).toBe(404);
    const rows = await readAuditRows();
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        custodyConfigId: config,
        provider: "privy",
        reason: "persistence_failed",
        auditIntentId: rows[0]?.resource_id,
        walletId: "privy_config_orphan",
      }),
      "custody_wallet_orphan_risk"
    );
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      status: "failure",
      metadata: {
        auditPhase: "outcome",
        event: "default_wallet_change_failed",
        reason: "selection_unavailable",
        walletId: "privy_config_orphan",
      },
    });
  });

  it.each([
    ["organization", "org_other_scope", project],
    ["project", org, "prj_other_scope"],
  ] as const)(
    "does not lock or promote a Config from another %s",
    async (_scope, orgId, projectId) => {
      const created = await new CustodyConfigStore(getDb(env), env).createDefaultWallet(
        config,
        orgId,
        projectId,
        {
          id: "cwlt_config_foreign",
          walletId: "privy_config_foreign",
          publicKey: "SysvarRent111111111111111111111111111111111",
        }
      );

      expect(created).toBeNull();
      expect(await readDefault("config")).toEqual({ wallet_id: "privy_config_a" });
      expect(
        await getDb(env).queryMany("SELECT id FROM custody_wallets WHERE id = ?", [
          "cwlt_config_foreign",
        ])
      ).toEqual([]);
    }
  );

  it("keeps Config selection available while BYOK is disabled", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    expect((await changeDefault("config")).status).toBe(200);
    expect(await readDefault("config")).toEqual({ wallet_id: "privy_config_b" });
  });
});
