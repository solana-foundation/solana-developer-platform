import { hashString } from "@sdp/payments/hash";
import { type CachedApiKey, CUSTODY_CONFIG_STATUSES, type CustodyConfigStatus } from "@sdp/types";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db";
import app from "@/index";
import { initializeSigningResponseSchema } from "@/openapi/schemas/custody";
import type { SwitchSigningRequest } from "@/routes/custody/schemas";
import { getLogger } from "@/runtime/logger";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG = {
  id: "org_custody_multi_provider",
  name: "Custody Multi Provider Org",
  slug: "custody-multi-provider-org",
};

const TEST_PROJECT = {
  id: "prj_test_custody_multi_provider",
  slug: "test-custody-multi-provider-project",
};

const TEST_USER = {
  id: "usr_custody_multi_provider",
  email: "custody-multi-provider@example.com",
};

const TEST_API_KEY = {
  id: "key_custody_multi_provider",
  raw: "sk_test_custody_multi_provider",
  prefix: "sk_test_cus",
};

const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

const PRIVY_CONFIG_ID = "cust_cfg_privy_multi";
const PARA_CONFIG_ID = "cust_cfg_para_multi";
const DFNS_CONFIG_ID = "cust_cfg_dfns_legacy";
const IBM_HAVEN_CONFIG_ID = "cust_cfg_ibm_haven";

let originalParaApiKey: string | undefined;
let originalPrivyByokEnabled: string | undefined;
let originalPrivyAppId: string | undefined;
let originalPrivyAppSecret: string | undefined;
let originalCustodyEncryptionKey: string | undefined;

async function switchProvider(body: SwitchSigningRequest): Promise<Response> {
  return app.request(
    "/v1/wallets/switch",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${TEST_API_KEY.raw}`,
      },
      body: JSON.stringify(body),
    },
    env
  );
}

async function readScopeDefault() {
  return getDb(env).queryOne<{
    default_custody_config_id: string | null;
    default_custody_connection_id: string | null;
  }>(
    `SELECT default_custody_config_id, default_custody_connection_id
     FROM custody_scope_defaults WHERE organization_id = ? AND project_id = ?`,
    [TEST_ORG.id, TEST_PROJECT.id]
  );
}

async function prepareParaConfig(status: CustodyConfigStatus | "absent") {
  const db = getDb(env);
  if (status === "absent") {
    await db.batch([
      db.prepare("DELETE FROM custody_wallets WHERE custody_config_id = ?").bind(PARA_CONFIG_ID),
      db.prepare("DELETE FROM custody_configs WHERE id = ?").bind(PARA_CONFIG_ID),
    ]);
  } else {
    await db.execute("UPDATE custody_configs SET status = ? WHERE id = ?", [
      status,
      PARA_CONFIG_ID,
    ]);
  }
  const providerFetch = vi.fn(async () =>
    Response.json({
      id: "para_wallet_initialized",
      address: "11111111111111111111111111111111",
      type: "SOLANA",
      scheme: "ED25519",
      status: "ready",
    })
  );
  vi.stubGlobal("fetch", providerFetch);
  return providerFetch;
}

async function readSwitchAudit() {
  const rows = await getDb(env).queryMany<{
    action: string;
    resource_type: string;
    resource_id: string;
    api_key_id: string | null;
    request_id: string | null;
    metadata: string;
  }>(
    "SELECT action, resource_type, resource_id, api_key_id, request_id, metadata FROM audit_logs WHERE organization_id = ? ORDER BY ledger_sequence",
    [TEST_ORG.id]
  );
  return rows.map((row) => ({
    ...row,
    metadata: z.record(z.string(), z.json()).parse(JSON.parse(row.metadata)),
  }));
}

async function seedAuthAndConfigs(): Promise<void> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, TEST_CACHED_API_KEY);

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug, "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER.id, TEST_USER.email, 1, "active"),
  ]);
  await seedDefaultProjects(getDb(env), {
    organizationId: TEST_ORG.id,
    createdBy: TEST_USER.id,
    members: [],
    ids: { sandbox: TEST_PROJECT.id, production: `${TEST_PROJECT.id}_production` },
  });
  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG.id,
        TEST_PROJECT.id,
        TEST_USER.id,
        "Custody Multi Provider Test Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PRIVY_CONFIG_ID,
        TEST_ORG.id,
        TEST_PROJECT.id,
        "privy",
        "test-config",
        "sdp-custody-encryption-v1",
        "privy_wallet_a",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        PARA_CONFIG_ID,
        TEST_ORG.id,
        TEST_PROJECT.id,
        "para",
        "test-config",
        "sdp-custody-encryption-v1",
        "para_wallet_a",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind("csd_multi_org_default", TEST_ORG.id, TEST_PROJECT.id, PRIVY_CONFIG_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_privy_a",
        PRIVY_CONFIG_ID,
        "privy_wallet_a",
        "privy_pubkey_a",
        "Privy Root A",
        "root",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_privy_b",
        PRIVY_CONFIG_ID,
        "privy_wallet_b",
        "privy_pubkey_b",
        "Privy Root B",
        "transfer",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_para_a",
        PARA_CONFIG_ID,
        "para_wallet_a",
        "11111111111111111111111111111111",
        "Para Root A",
        "root",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cwlt_para_b",
        PARA_CONFIG_ID,
        "para_wallet_b",
        "para_pubkey_b",
        "Para Root B",
        "transfer",
        "active"
      ),
  ]);
}

async function seedActivePrivyConnection(suffix: string, projectId = TEST_PROJECT.id) {
  const credentialId = `pcred_switch_${suffix}`;
  const connectionId = `cconn_switch_${suffix}`;
  const walletRecordId = `cwlt_switch_${suffix}`;
  const walletId = `privy_switch_${suffix}`;
  const publicKey = "11111111111111111111111111111111";

  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO provider_credentials (
           id, organization_id, project_id, provider, label, scope, source,
           storage_backend, encrypted_secret_payload, status, created_by
         ) VALUES (?, ?, ?, 'privy', ?, 'project', 'stored',
                   'encrypted_db', 'ciphertext', 'active', ?)`
      )
      .bind(credentialId, TEST_ORG.id, projectId, `Privy ${suffix}`, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_connections (
           id, organization_id, project_id, provider, scope,
           provider_credential_id, provider_credential_scope_key, status, created_by
         ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
      )
      .bind(connectionId, TEST_ORG.id, projectId, credentialId, projectId, TEST_USER.id),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets (
           id, custody_connection_id, wallet_id, public_key, status
         ) VALUES (?, ?, ?, ?, 'active')`
      )
      .bind(walletRecordId, connectionId, walletId, publicKey),
    getDb(env)
      .prepare(
        `UPDATE custody_connections
         SET default_custody_wallet_id = ?, status = 'active',
             last_check_status = 'success', last_check_at = sdp_iso_now(),
             provider_account_fingerprint = ?,
             activated_at = sdp_iso_now()
         WHERE id = ?`
      )
      .bind(walletRecordId, `sha256:${credentialId}`, connectionId),
  ]);

  return { connectionId, walletId, publicKey };
}

describe("Custody multi-provider routes", () => {
  beforeEach(async () => {
    originalParaApiKey = env.PARA_API_KEY;
    originalPrivyByokEnabled = env.PRIVY_BYOK_ENABLED;
    originalPrivyAppId = env.PRIVY_APP_ID;
    originalPrivyAppSecret = env.PRIVY_APP_SECRET;
    originalCustodyEncryptionKey = env.CUSTODY_ENCRYPTION_KEY;
    env.CUSTODY_ENCRYPTION_KEY = "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=";
    env.PARA_API_KEY = "para_test_api_key";
    await seedTestDatabase(env);
    await seedAuthAndConfigs();
  });

  afterEach(async () => {
    env.PARA_API_KEY = originalParaApiKey;
    env.PRIVY_BYOK_ENABLED = originalPrivyByokEnabled;
    env.PRIVY_APP_ID = originalPrivyAppId;
    env.PRIVY_APP_SECRET = originalPrivyAppSecret;
    env.CUSTODY_ENCRYPTION_KEY = originalCustodyEncryptionKey;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await clearKVStores(env);
  });

  it.each([...CUSTODY_CONFIG_STATUSES, "absent"] as const)(
    "rejects unavailable provider for an %s Config before opening an audit intent",
    async (status) => {
      const providerFetch = await prepareParaConfig(status);
      const before = await readScopeDefault();
      env.PARA_API_KEY = undefined;

      const response = await switchProvider({ provider: "para" });

      expect(response.status).toBe(403);
      expect(providerFetch).not.toHaveBeenCalled();
      expect(await readScopeDefault()).toEqual(before);
      expect(await readSwitchAudit()).toHaveLength(0);
    }
  );

  it("rejects fresh legacy Privy setup before opening an audit intent", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = "legacy-privy-app";
    env.PRIVY_APP_SECRET = "legacy-privy-secret";
    await getDb(env).execute("UPDATE custody_configs SET status = 'inactive' WHERE id = ?", [
      PRIVY_CONFIG_ID,
    ]);
    const before = await readScopeDefault();
    const providerFetch = vi.fn();
    vi.stubGlobal("fetch", providerFetch);

    const response = await switchProvider({ provider: "privy" });

    expect(response.status).toBe(403);
    expect(providerFetch).not.toHaveBeenCalled();
    expect(await readScopeDefault()).toEqual(before);
    expect(await readSwitchAudit()).toHaveLength(0);
  });

  it.each([...CUSTODY_CONFIG_STATUSES, "absent"] as const)(
    "does not change an %s Config when the audit intent cannot persist",
    async (status) => {
      const db = getDb(env);
      const providerFetch = await prepareParaConfig(status);
      await db.execute(
        `ALTER TABLE audit_logs ADD CONSTRAINT fail_switch_intent
       CHECK (metadata::jsonb->>'auditPhase' IS DISTINCT FROM 'intent') NOT VALID`
      );
      try {
        const response = await switchProvider({ provider: "para" });
        expect(response.status).toBe(500);
        expect(await readScopeDefault()).toEqual({
          default_custody_config_id: PRIVY_CONFIG_ID,
          default_custody_connection_id: null,
        });
        expect(providerFetch).not.toHaveBeenCalled();
        expect(
          await db.queryOne("SELECT status FROM custody_configs WHERE id = ?", [PARA_CONFIG_ID])
        ).toEqual(status === "absent" ? null : { status });
      } finally {
        await db.execute("ALTER TABLE audit_logs DROP CONSTRAINT fail_switch_intent");
      }
    }
  );

  it.each([...CUSTODY_CONFIG_STATUSES, "absent"] as const)(
    "keeps an %s Config switch successful when later audit writes fail",
    async (status) => {
      const db = getDb(env);
      const providerFetch = await prepareParaConfig(status);
      await db.execute(
        `ALTER TABLE audit_logs ADD CONSTRAINT fail_switch_outcome
       CHECK (metadata::jsonb->>'auditPhase' IS NOT DISTINCT FROM 'intent') NOT VALID`
      );
      try {
        const response = await switchProvider({ provider: "para" });
        expect(response.status).toBe(201);
        const body = z
          .object({ data: initializeSigningResponseSchema.strict() })
          .parse(await response.json());
        expect(await readScopeDefault()).toEqual({
          default_custody_config_id: body.data.configId,
          default_custody_connection_id: null,
        });
        expect(providerFetch).toHaveBeenCalledTimes(status === "absent" ? 2 : 0);
        const audit = await readSwitchAudit();
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({
          api_key_id: TEST_API_KEY.id,
          metadata: { auditPhase: "intent", target: { metadata: { ownerKind: "config" } } },
        });
      } finally {
        await db.execute("ALTER TABLE audit_logs DROP CONSTRAINT fail_switch_outcome");
      }
    }
  );

  it.each(["intent", "outcome"] as const)(
    "handles unavailable Connection audit %s without a misleading selection",
    async (phase) => {
      env.PRIVY_BYOK_ENABLED = "true";
      const connection = await seedActivePrivyConnection(`audit_${phase}`);
      const db = getDb(env);
      await db.execute(`ALTER TABLE audit_logs ADD CONSTRAINT fail_connection_audit
      CHECK (metadata::jsonb->>'auditPhase' IS DISTINCT FROM '${phase}') NOT VALID`);
      try {
        const response = await switchProvider({ connectionId: connection.connectionId });
        expect(response.status).toBe(phase === "intent" ? 500 : 201);
        expect(await readScopeDefault()).toEqual({
          default_custody_config_id: PRIVY_CONFIG_ID,
          default_custody_connection_id: phase === "intent" ? null : connection.connectionId,
        });
        expect(await readSwitchAudit()).toHaveLength(phase === "intent" ? 0 : 1);
      } finally {
        await db.execute("ALTER TABLE audit_logs DROP CONSTRAINT fail_connection_audit");
      }
    }
  );

  it("audits one actual Connection transition and a technical completion for concurrent same-target switches", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    const connection = await seedActivePrivyConnection("concurrent_audit");
    const responses = await Promise.all([
      switchProvider({ connectionId: connection.connectionId }),
      switchProvider({ connectionId: connection.connectionId }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const audit = await readSwitchAudit();
    const outcomes = audit.filter((row) => row.metadata.auditPhase === "outcome");
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((row) => row.metadata.completionStatus === "success")).toMatchObject({
      resource_type: "custody_connection",
      resource_id: connection.connectionId,
      api_key_id: TEST_API_KEY.id,
      metadata: {
        event: "default_provider_changed",
        selections: [
          {
            previousConfigId: PRIVY_CONFIG_ID,
            previousConnectionId: null,
            selectedConfigId: PRIVY_CONFIG_ID,
            selectedConnectionId: connection.connectionId,
          },
        ],
      },
    });
    expect(outcomes.find((row) => row.metadata.completionStatus === "noop")).toMatchObject({
      action: "maintenance",
      resource_type: "audit_ledger",
      metadata: { event: "default_provider_selection_completed" },
    });
  });

  it("retains the confirmed initialization audit when the final selection commit response is lost", async () => {
    await prepareParaConfig("inactive");
    const db = getDb(env);
    await db.execute(
      "DELETE FROM custody_scope_defaults WHERE organization_id = ? AND project_id = ?",
      [TEST_ORG.id, TEST_PROJECT.id]
    );
    const transaction = db.transaction.bind(db);
    const errorLog = vi.spyOn(getLogger(), "error");
    vi.spyOn(db, "transaction").mockImplementation(async (callback) => {
      const result = await transaction(callback);
      if (
        result &&
        typeof result === "object" &&
        "previousConfigId" in result &&
        result.previousConfigId === PARA_CONFIG_ID
      ) {
        throw new Error("selection commit response lost");
      }
      return result;
    });
    const response = await switchProvider({ provider: "para" });
    expect(response.status).toBe(500);
    const audit = await readSwitchAudit();
    expect(audit).toMatchObject([
      { metadata: { auditPhase: "intent" } },
      { metadata: { event: "provider_initialization_completed" } },
    ]);
    expect(audit).toHaveLength(2);
    const [intent, initialization] = audit;
    assert(intent);
    assert(initialization);
    expect(initialization.metadata.commandAuditIntentId).toBe(intent.resource_id);
    expect(initialization.metadata.defaultSelection).toEqual({
      previousConfigId: null,
      previousConnectionId: null,
      selectedConfigId: PARA_CONFIG_ID,
      selectedConnectionId: null,
    });
    expect(await readScopeDefault()).toEqual({
      default_custody_config_id: PARA_CONFIG_ID,
      default_custody_connection_id: null,
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "custody_default_selection_outcome_unknown",
        initializedConfigId: PARA_CONFIG_ID,
        reason: "selection_outcome_unconfirmed",
      })
    );
  });

  it("records concurrent inactive Config initialization as command completions without claiming two reactivations", async () => {
    await prepareParaConfig("inactive");
    const db = getDb(env);
    const transaction = db.transaction.bind(db);
    let release = () => {};
    const bothInitializationsReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    let transactionCalls = 0;
    // Hold the first initialization before its database transaction starts until
    // the other request also passed the inactive Config checks. No writes occur
    // under this barrier, so both requests deterministically observe the race.
    vi.spyOn(db, "transaction").mockImplementation(async (callback) => {
      transactionCalls += 1;
      if (transactionCalls <= 2) {
        if (transactionCalls === 2) release();
        await bothInitializationsReady;
      }
      return transaction(callback);
    });

    const responses = await Promise.all([
      switchProvider({ provider: "para" }),
      switchProvider({ provider: "para" }),
    ]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const audit = await readSwitchAudit();
    const initializations = audit.filter(
      (row) => row.metadata.event === "provider_initialization_completed"
    );
    expect(initializations).toHaveLength(2);
    for (const entry of initializations) {
      expect(entry).toMatchObject({
        action: "maintenance",
        resource_type: "audit_ledger",
        metadata: { configId: PARA_CONFIG_ID },
      });
      expect(entry.resource_id).toBe(entry.metadata.commandAuditIntentId);
    }
    expect(
      audit.filter(
        (row) =>
          row.metadata.event === "provider_reactivated" ||
          row.metadata.event === "provider_connected"
      )
    ).toEqual([]);
    expect(audit.filter((row) => row.metadata.event === "default_provider_changed")).toHaveLength(
      1
    );
  });

  it("switches default provider without deactivating other active providers", async () => {
    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "para",
        }),
      },
      env
    );

    expect(res.status).toBe(201);

    const activeConfigs = await getDb(env)
      .prepare(
        `SELECT provider, status
         FROM custody_configs
         WHERE organization_id = ?
         ORDER BY provider`
      )
      .bind(TEST_ORG.id)
      .all<{ provider: string; status: string }>();

    expect(activeConfigs.results).toEqual([
      { provider: "para", status: "active" },
      { provider: "privy", status: "active" },
    ]);

    const defaultPointer = await getDb(env)
      .prepare(
        `SELECT default_custody_config_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?
         LIMIT 1`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{ default_custody_config_id: string }>();

    expect(defaultPointer?.default_custody_config_id).toBe(PARA_CONFIG_ID);
  });

  it("switches to an exact Connection without clearing the legacy Config pointer", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    const connection = await seedActivePrivyConnection("exact");

    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ connectionId: connection.connectionId, provider: "privy" }),
      },
      env
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: {
        connectionId: connection.connectionId,
        walletId: connection.walletId,
        publicKey: connection.publicKey,
      },
    });
    const target = await getDb(env)
      .prepare(
        `SELECT default_custody_config_id, default_custody_connection_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{
        default_custody_config_id: string | null;
        default_custody_connection_id: string | null;
      }>();
    expect(target).toEqual({
      default_custody_config_id: PRIVY_CONFIG_ID,
      default_custody_connection_id: connection.connectionId,
    });

    const mismatch = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ connectionId: connection.connectionId, provider: "turnkey" }),
      },
      env
    );
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("rejects an active Connection without a Provider Account fingerprint", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    const connection = await seedActivePrivyConnection("missing_fingerprint");
    await getDb(env)
      .prepare("UPDATE custody_connections SET provider_account_fingerprint = NULL WHERE id = ?")
      .bind(connection.connectionId)
      .run();

    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ connectionId: connection.connectionId }),
      },
      env
    );

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: "CONFLICT" } });
  });

  it.each([
    [{ connectionId: "cconn_missing" }, 404, "NOT_FOUND"],
    [{ connectionId: "cconn_switch_unusable" }, 409, "CONFLICT"],
  ] as const)("rejects an unavailable exact Connection with %s", async (request, status, code) => {
    env.PRIVY_BYOK_ENABLED = "true";
    if (request.connectionId === "cconn_switch_unusable") {
      const credentialId = "pcred_switch_unusable";
      await getDb(env).batch([
        getDb(env)
          .prepare(
            `INSERT INTO provider_credentials (
               id, organization_id, project_id, provider, label, scope, source,
               storage_backend, encrypted_secret_payload, status, created_by
             ) VALUES (?, ?, ?, 'privy', 'Privy unusable', 'project', 'stored',
                       'encrypted_db', 'ciphertext', 'pending', ?)`
          )
          .bind(credentialId, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id),
        getDb(env)
          .prepare(
            `INSERT INTO custody_connections (
               id, organization_id, project_id, provider, scope,
               provider_credential_id, provider_credential_scope_key, status, created_by
             ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)`
          )
          .bind(
            request.connectionId,
            TEST_ORG.id,
            TEST_PROJECT.id,
            credentialId,
            TEST_PROJECT.id,
            TEST_USER.id
          ),
      ]);
    }

    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify(request),
      },
      env
    );

    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: { code } });
  });

  it("rejects an exact Connection while Connection runtime is disabled", async () => {
    env.PRIVY_BYOK_ENABLED = "false";
    const connection = await seedActivePrivyConnection("disabled");

    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ connectionId: connection.connectionId }),
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
  });

  it("rejects an exact Connection switch without changing the target when entitlement is revoked", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    const connection = await seedActivePrivyConnection("unentitled");
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { custody: { privy: false } } }), TEST_ORG.id)
      .run();

    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ connectionId: connection.connectionId }),
      },
      env
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "FORBIDDEN" } });
    expect(
      await getDb(env)
        .prepare(
          `SELECT default_custody_config_id, default_custody_connection_id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id)
        .first()
    ).toEqual({
      default_custody_config_id: PRIVY_CONFIG_ID,
      default_custody_connection_id: null,
    });
  });

  it.each([null, "", 42])("rejects a malformed Connection selector: %s", async (connectionId) => {
    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ provider: "privy", connectionId }),
      },
      env
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "BAD_REQUEST" } });
  });

  it("keeps provider-only switching on the active Config when Connections are candidates", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    env.PRIVY_APP_ID = "privy_test_app_id";
    env.PRIVY_APP_SECRET = "privy_test_app_secret";
    await seedActivePrivyConnection("candidate_a");
    await seedActivePrivyConnection("candidate_b");
    await getDb(env)
      .prepare(
        `UPDATE custody_scope_defaults
         SET default_custody_config_id = ?
         WHERE organization_id = ? AND project_id = ?`
      )
      .bind(PARA_CONFIG_ID, TEST_ORG.id, TEST_PROJECT.id)
      .run();

    const res = await app.request(
      "/v1/wallets/switch",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({ provider: "privy" }),
      },
      env
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      data: {
        configId: PRIVY_CONFIG_ID,
        walletId: "privy_wallet_a",
        publicKey: "privy_pubkey_a",
      },
    });
    const target = await getDb(env)
      .prepare(
        `SELECT default_custody_config_id, default_custody_connection_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{
        default_custody_config_id: string | null;
        default_custody_connection_id: string | null;
      }>();
    expect(target).toEqual({
      default_custody_config_id: PRIVY_CONFIG_ID,
      default_custody_connection_id: null,
    });
  });

  it("lists all provider wallets by default and can opt into default-provider-only results", async () => {
    const defaultRes = await app.request(
      "/v1/wallets",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(defaultRes.status).toBe(200);
    const defaultBody = (await defaultRes.json()) as {
      data: {
        wallets: Array<{ provider?: string; isDefaultProvider?: boolean; walletId: string }>;
      };
    };

    expect(defaultBody.data.wallets).toHaveLength(4);
    expect(new Set(defaultBody.data.wallets.map((wallet) => wallet.provider))).toEqual(
      new Set(["privy", "para"])
    );
    expect(
      defaultBody.data.wallets
        .filter((wallet) => wallet.isDefaultProvider)
        .map((wallet) => wallet.provider)
    ).toEqual(["privy", "privy"]);

    const defaultProviderOnlyQuery = new URLSearchParams({
      includeAllProviders: "false",
    }).toString();

    const defaultProviderOnlyRes = await app.request(
      `/v1/wallets?${defaultProviderOnlyQuery}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(defaultProviderOnlyRes.status).toBe(200);
    const defaultProviderOnlyBody = (await defaultProviderOnlyRes.json()) as {
      data: {
        wallets: Array<{ provider?: string; isDefaultProvider?: boolean; walletId: string }>;
      };
    };

    expect(defaultProviderOnlyBody.data.wallets).toHaveLength(2);
    expect(
      defaultProviderOnlyBody.data.wallets.every((wallet) => wallet.provider === "privy")
    ).toBe(true);
    expect(
      defaultProviderOnlyBody.data.wallets.every((wallet) => wallet.isDefaultProvider === true)
    ).toBe(true);
  });

  it("keeps active Connection wallets visible with fresh Runtime Execution Admission", async () => {
    env.PRIVY_BYOK_ENABLED = "true";
    const connection = await seedActivePrivyConnection("inventory");

    const readWallet = async () => {
      const response = await app.request(
        "/v1/wallets",
        {
          method: "GET",
          headers: { Authorization: `Bearer ${TEST_API_KEY.raw}` },
        },
        env
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        data: {
          wallets: Array<Record<string, unknown> & { walletId: string }>;
        };
      };
      return body.data.wallets.find((wallet) => wallet.walletId === connection.walletId);
    };

    await expect(readWallet()).resolves.toMatchObject({
      custodyConnectionId: connection.connectionId,
      isDefaultProvider: false,
      isRuntimeExecutionAllowed: true,
      provider: "privy",
    });

    env.PRIVY_BYOK_ENABLED = "false";
    await expect(readWallet()).resolves.toMatchObject({
      custodyConnectionId: connection.connectionId,
      isDefaultProvider: false,
      isRuntimeExecutionAllowed: false,
      provider: "privy",
    });

    env.PRIVY_BYOK_ENABLED = "true";
    await getDb(env)
      .prepare("UPDATE organizations SET settings = ? WHERE id = ?")
      .bind(JSON.stringify({ providerOverrides: { custody: { privy: false } } }), TEST_ORG.id)
      .run();
    await expect(readWallet()).resolves.toMatchObject({
      custodyConnectionId: connection.connectionId,
      isDefaultProvider: false,
      isRuntimeExecutionAllowed: false,
      provider: "privy",
    });
  });

  it("returns active configs and defaultConfigId from /v1/wallets/configs", async () => {
    const res = await app.request(
      "/v1/wallets/configs",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        defaultConfigId: string | null;
        configs: Array<{ id: string; provider: string; isDefault: boolean }>;
      };
    };

    expect(body.data.defaultConfigId).toBe(PRIVY_CONFIG_ID);
    expect(body.data.configs).toHaveLength(2);
    expect(
      body.data.configs.map((config) => ({
        provider: config.provider,
        isDefault: config.isDefault,
      }))
    ).toEqual(
      expect.arrayContaining([
        { provider: "para", isDefault: false },
        { provider: "privy", isDefault: true },
      ])
    );
  });

  it("skips active configs without wallets in /v1/wallets/configs instead of failing", async () => {
    const walletlessConfigId = "cust_cfg_walletless";
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          walletlessConfigId,
          TEST_ORG.id,
          TEST_PROJECT.id,
          "turnkey",
          "test-config",
          "sdp-custody-encryption-v1",
          null,
          "active"
        ),
      getDb(env)
        .prepare(
          `UPDATE custody_scope_defaults
           SET default_custody_config_id = ?, updated_at = datetime('now')
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(walletlessConfigId, TEST_ORG.id, TEST_PROJECT.id),
    ]);

    const res = await app.request(
      "/v1/wallets/configs",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        defaultConfigId: string | null;
        configs: Array<{ id: string; provider: string; isDefault: boolean }>;
      };
    };

    expect(body.data.configs.map((config) => config.provider)).toEqual(
      expect.arrayContaining(["privy", "para"])
    );
    expect(body.data.configs.some((config) => config.id === walletlessConfigId)).toBe(false);
    expect(body.data.defaultConfigId).toBeNull();
    expect(body.data.configs.some((config) => config.isDefault)).toBe(false);
  });

  it("returns config for legacy default providers without adapter resolution", async () => {
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          DFNS_CONFIG_ID,
          TEST_ORG.id,
          TEST_PROJECT.id,
          "dfns",
          "legacy-config",
          "sdp-custody-encryption-v1",
          "dfns_wallet_a",
          "active"
        ),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "cwlt_dfns_a",
          DFNS_CONFIG_ID,
          "dfns_wallet_a",
          "dfns_pubkey_a",
          "Dfns Root A",
          "root",
          "active"
        ),
      getDb(env)
        .prepare(
          `UPDATE custody_scope_defaults
           SET default_custody_config_id = ?, updated_at = datetime('now')
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(DFNS_CONFIG_ID, TEST_ORG.id, TEST_PROJECT.id),
    ]);

    const res = await app.request(
      "/v1/wallets/config",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        config: { id: string; provider: string; publicKey: string };
      };
    };

    expect(body.data.config.id).toBe(DFNS_CONFIG_ID);
    expect(body.data.config.provider).toBe("dfns");
    expect(body.data.config.publicKey).toBe("dfns_pubkey_a");
  });

  it("returns config for an ibm_haven default provider without adapter resolution", async () => {
    // IBM Digital Asset Haven wallets are stored with an `ibmhaven_` prefix (white-label Dfns).
    await getDb(env).batch([
      getDb(env)
        .prepare(
          `INSERT INTO custody_configs
             (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          IBM_HAVEN_CONFIG_ID,
          TEST_ORG.id,
          TEST_PROJECT.id,
          "ibm_haven",
          "legacy-config",
          "sdp-custody-encryption-v1",
          "ibmhaven_wallet_haven",
          "active"
        ),
      getDb(env)
        .prepare(
          `INSERT INTO custody_wallets
             (id, custody_config_id, wallet_id, public_key, label, purpose, status)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          "cwlt_ibm_haven",
          IBM_HAVEN_CONFIG_ID,
          "ibmhaven_wallet_haven",
          "haven_pubkey",
          "Haven Root",
          "root",
          "active"
        ),
      getDb(env)
        .prepare(
          `UPDATE custody_scope_defaults
           SET default_custody_config_id = ?, updated_at = datetime('now')
           WHERE organization_id = ? AND project_id = ?`
        )
        .bind(IBM_HAVEN_CONFIG_ID, TEST_ORG.id, TEST_PROJECT.id),
    ]);

    const res = await app.request(
      "/v1/wallets/config",
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
      },
      env
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        config: { id: string; provider: string; publicKey: string };
      };
    };

    expect(body.data.config.id).toBe(IBM_HAVEN_CONFIG_ID);
    expect(body.data.config.provider).toBe("ibm_haven");
    expect(body.data.config.publicKey).toBe("haven_pubkey");
  });

  it("sets default wallet for an explicitly targeted provider", async () => {
    const res = await app.request(
      "/v1/wallets/default-wallet",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "para",
          walletId: "para_wallet_b",
        }),
      },
      env
    );

    expect(res.status).toBe(200);

    const paraConfig = await getDb(env)
      .prepare(
        `SELECT default_wallet_id
         FROM custody_configs
         WHERE id = ?
         LIMIT 1`
      )
      .bind(PARA_CONFIG_ID)
      .first<{ default_wallet_id: string | null }>();

    expect(paraConfig?.default_wallet_id).toBe("para_wallet_b");

    const defaultPointer = await getDb(env)
      .prepare(
        `SELECT default_custody_config_id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?
         LIMIT 1`
      )
      .bind(TEST_ORG.id, TEST_PROJECT.id)
      .first<{ default_custody_config_id: string }>();

    expect(defaultPointer?.default_custody_config_id).toBe(PRIVY_CONFIG_ID);
  });

  it("returns 404 when creating a wallet for an uninitialized provider", async () => {
    const res = await app.request(
      "/v1/wallets",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "coinbase_cdp",
          label: "Missing provider wallet",
        }),
      },
      env
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Custody not initialized");
  });

  it("returns 404 when deleting a wallet for an uninitialized provider", async () => {
    const res = await app.request(
      "/v1/wallets",
      {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TEST_API_KEY.raw}`,
        },
        body: JSON.stringify({
          provider: "coinbase_cdp",
          walletId: "cdp_wallet_missing",
        }),
      },
      env
    );

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
      };
    };
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("Custody not initialized");
  });
});
