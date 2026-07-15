import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PolicyControlInventoryResponse } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVNamespaces, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG_ID = "org_policy_inventory";
const TEST_PROJECT_ID = "prj_policy_inventory";
const OTHER_PROJECT_ID = "prj_policy_inventory_other";
const OTHER_ORG_ID = "org_policy_inventory_other";
const TEST_USER_ID = "usr_policy_inventory";
const OTHER_USER_ID = "usr_policy_inventory_other";
const TEST_API_KEY = {
  id: "key_policy_inventory_auth",
  raw: "sk_test_policy_inventory_auth",
  prefix: "sk_test_policy_auth",
};

const cachedApiKey = (
  permissions: CachedApiKey["permissions"] = ["*"],
  walletBindings?: CachedApiKey["walletBindings"]
): CachedApiKey => ({
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG_ID,
  projectId: TEST_PROJECT_ID,
  role: "api_admin",
  permissions,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  walletBindings,
  status: "active",
  expiresAt: null,
});

async function seedPolicyInventory(): Promise<string> {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedApiKey());

  await getDb(env).batch([
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(TEST_ORG_ID, "Policy Inventory", "policy-inventory", "enterprise", "active"),
    getDb(env)
      .prepare("INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, ?, ?)")
      .bind(
        OTHER_ORG_ID,
        "Other Policy Inventory",
        "other-policy-inventory",
        "enterprise",
        "active"
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER_ID, "policy-inventory@example.com", 1, "active"),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(OTHER_USER_ID, "other-policy-inventory@example.com", 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT_ID,
        TEST_ORG_ID,
        "Policy Inventory Project",
        "policy-inventory-project",
        "sandbox",
        "active",
        TEST_USER_ID
      ),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        OTHER_PROJECT_ID,
        TEST_ORG_ID,
        "Other Policy Project",
        "other-policy-project",
        "sandbox",
        "active",
        TEST_USER_ID
      ),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "prj_policy_inventory_foreign",
        OTHER_ORG_ID,
        "Foreign Policy Project",
        "foreign-policy-project",
        "sandbox",
        "active",
        OTHER_USER_ID
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        TEST_USER_ID,
        "Inventory Auth Key",
        TEST_API_KEY.prefix,
        keyHash,
        "api_admin",
        JSON.stringify(["*"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "key_policy_inventory_default",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        TEST_USER_ID,
        "Reporting Key",
        "sk_test_report",
        "hash_policy_inventory_default",
        "api_developer",
        JSON.stringify(["payments:read"]),
        "active",
        "2026-07-02T00:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "key_policy_inventory_active",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        TEST_USER_ID,
        "Treasury Automation",
        "sk_test_treasury",
        "hash_policy_inventory_active",
        "api_developer",
        JSON.stringify(["payments:write"]),
        "active",
        "2026-07-03T00:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "key_policy_inventory_other_project",
        TEST_ORG_ID,
        OTHER_PROJECT_ID,
        TEST_USER_ID,
        "Other Project Key",
        "sk_test_other",
        "hash_policy_inventory_other_project",
        "api_developer",
        JSON.stringify(["payments:read"]),
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_configs
           (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
         VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cfg_policy_inventory",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        "fireblocks",
        "encrypted-main",
        "sdp-custody-encryption-v1",
        "active",
        "cfg_policy_inventory_null",
        TEST_ORG_ID,
        null,
        "local",
        "encrypted-null",
        "sdp-custody-encryption-v1",
        "active",
        "cfg_policy_inventory_other_project",
        TEST_ORG_ID,
        OTHER_PROJECT_ID,
        "local",
        "encrypted-other",
        "sdp-custody-encryption-v1",
        "active",
        "cfg_policy_inventory_foreign",
        OTHER_ORG_ID,
        "prj_policy_inventory_foreign",
        "local",
        "encrypted-foreign",
        "sdp-custody-encryption-v1",
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status, created_at, updated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "cw_policy_inventory_default",
        "cfg_policy_inventory",
        "wallet_policy_inventory_default",
        "address_policy_inventory_default",
        "Default Treasury",
        "transfer",
        "active",
        "2026-07-04T00:00:00.000Z",
        "2026-07-04T00:00:00.000Z",
        "cw_policy_inventory_draft",
        "cfg_policy_inventory",
        "wallet_policy_inventory_draft",
        "address_policy_inventory_draft",
        "Draft Operations",
        "transfer",
        "active",
        "2026-07-05T00:00:00.000Z",
        "2026-07-05T00:00:00.000Z",
        "cw_policy_inventory_active",
        "cfg_policy_inventory",
        "wallet_policy_inventory_active",
        "address_policy_inventory_active",
        "Active Treasury",
        "transfer",
        "active",
        "2026-07-06T00:00:00.000Z",
        "2026-07-06T00:00:00.000Z",
        "cw_policy_inventory_disabled",
        "cfg_policy_inventory",
        "wallet_policy_inventory_disabled",
        "address_policy_inventory_disabled",
        "Disabled Payroll",
        "transfer",
        "active",
        "2026-07-07T00:00:00.000Z",
        "2026-07-07T00:00:00.000Z",
        "cw_policy_inventory_null",
        "cfg_policy_inventory_null",
        "wallet_policy_inventory_null",
        "address_policy_inventory_null",
        "Organization Wallet",
        "transfer",
        "active",
        "2026-07-08T00:00:00.000Z",
        "2026-07-08T00:00:00.000Z",
        "cw_policy_inventory_other_project",
        "cfg_policy_inventory_other_project",
        "wallet_policy_inventory_other_project",
        "address_policy_inventory_other_project",
        "Other Project Wallet",
        "transfer",
        "active",
        "2026-07-09T00:00:00.000Z",
        "2026-07-09T00:00:00.000Z",
        "cw_policy_inventory_foreign",
        "cfg_policy_inventory_foreign",
        "wallet_policy_inventory_foreign",
        "address_policy_inventory_foreign",
        "Foreign Wallet",
        "transfer",
        "active",
        "2026-07-10T00:00:00.000Z",
        "2026-07-10T00:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO wallet_control_profiles
           (id, organization_id, project_id, custody_wallet_id, name, status, active_revision_id, created_at, updated_at, activated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?),
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "wcp_policy_inventory_draft",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        "cw_policy_inventory_draft",
        "Draft controls",
        "draft",
        null,
        "2026-07-11T00:00:00.000Z",
        "2026-07-11T00:00:00.000Z",
        null,
        "wcp_policy_inventory_active",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        "cw_policy_inventory_active",
        "Active controls",
        "active",
        "wcpr_policy_inventory_active",
        "2026-07-12T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
        "wcp_policy_inventory_disabled",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        "cw_policy_inventory_disabled",
        "Disabled controls",
        "disabled",
        "wcpr_policy_inventory_disabled",
        "2026-07-13T00:00:00.000Z",
        "2026-07-13T00:00:00.000Z",
        "2026-07-13T00:00:00.000Z",
        "wcp_policy_inventory_null",
        TEST_ORG_ID,
        null,
        "cw_policy_inventory_null",
        "Organization controls",
        "active",
        "wcpr_policy_inventory_null",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO wallet_control_profile_revisions
           (id, profile_id, revision_number, rules, default_action, created_at, activated_at)
         VALUES
           (?, ?, ?, ?::jsonb, ?, ?, ?),
           (?, ?, ?, ?::jsonb, ?, ?, ?),
           (?, ?, ?, ?::jsonb, ?, ?, ?),
           (?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        "wcpr_policy_inventory_draft",
        "wcp_policy_inventory_draft",
        1,
        JSON.stringify([{ kind: "operation_family" }, { kind: "amount" }]),
        "review",
        "2026-07-11T00:00:00.000Z",
        null,
        "wcpr_policy_inventory_active",
        "wcp_policy_inventory_active",
        2,
        JSON.stringify([{ kind: "destination" }]),
        "deny",
        "2026-07-12T00:00:00.000Z",
        "2026-07-12T00:00:00.000Z",
        "wcpr_policy_inventory_disabled",
        "wcp_policy_inventory_disabled",
        1,
        JSON.stringify([{ kind: "approval" }]),
        "approval_required",
        "2026-07-13T00:00:00.000Z",
        "2026-07-13T00:00:00.000Z",
        "wcpr_policy_inventory_null",
        "wcp_policy_inventory_null",
        1,
        JSON.stringify([{ kind: "always" }]),
        "deny",
        "2026-07-14T00:00:00.000Z",
        "2026-07-14T00:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_key_control_profiles
           (id, organization_id, project_id, api_key_id, name, status, active_revision_id, created_at, updated_at, activated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "akcp_policy_inventory_active",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        "key_policy_inventory_active",
        "Treasury key controls",
        "active",
        "akcpr_policy_inventory_active",
        "2026-07-15T00:00:00.000Z",
        "2026-07-15T00:00:00.000Z",
        "2026-07-15T00:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_key_control_profile_revisions
           (id, profile_id, revision_number, rules, default_action, created_at, activated_at)
         VALUES (?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        "akcpr_policy_inventory_active",
        "akcp_policy_inventory_active",
        3,
        JSON.stringify([{ kind: "operation_family" }, { kind: "asset" }]),
        "review",
        "2026-07-15T00:00:00.000Z",
        "2026-07-15T00:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO api_key_wallet_policy_bindings
           (id, api_key_id, binding_scope, wallet_id, custody_wallet_id, api_key_control_profile_id)
         VALUES (?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "akwpol_policy_inventory_a",
        "key_policy_inventory_active",
        "selected",
        "wallet_policy_inventory_active",
        "cw_policy_inventory_active",
        "akcp_policy_inventory_active",
        "akwpol_policy_inventory_b",
        "key_policy_inventory_active",
        "selected",
        "wallet_policy_inventory_default",
        "cw_policy_inventory_default",
        "akcp_policy_inventory_active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO policy_provider_sync_status
           (id, wallet_control_profile_revision_id, provider, status, custom_payload, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?::jsonb, ?, ?)`
      )
      .bind(
        "ppss_policy_inventory",
        "wcpr_policy_inventory_active",
        "fireblocks",
        "synced",
        JSON.stringify({ secretProviderPayload: "must-not-leak" }),
        "2026-07-15T01:00:00.000Z",
        "2026-07-15T01:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO wallet_operations
           (id, organization_id, project_id, custody_wallet_id, wallet_id, api_key_id, source, operation_family, operation_type, raw_payload, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, ?, ?)`
      )
      .bind(
        "wop_policy_inventory_latest",
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        "cw_policy_inventory_active",
        "wallet_policy_inventory_active",
        "key_policy_inventory_active",
        "api",
        "payment",
        "transfer",
        JSON.stringify({ secretRequestContext: "must-not-leak" }),
        "failed",
        "2026-07-15T02:00:00.000Z",
        "2026-07-15T02:00:00.000Z"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO policy_evaluations
           (id, wallet_operation_id, wallet_policy_revision_id, api_key_policy_revision_id, decision, reason_code, reason, matched_rules, evaluation_context, requires_approval, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb, ?, ?)`
      )
      .bind(
        "peval_policy_inventory_latest",
        "wop_policy_inventory_latest",
        "wcpr_policy_inventory_active",
        "akcpr_policy_inventory_active",
        "deny",
        "wallet_policy_match",
        "Sensitive reason",
        JSON.stringify([{ secretRuleContext: "must-not-leak" }]),
        JSON.stringify({ secretEvaluationContext: "must-not-leak" }),
        false,
        "2026-07-15T02:01:00.000Z"
      ),
  ]);

  return keyHash;
}

function authHeaders() {
  return { Authorization: `Bearer ${TEST_API_KEY.raw}` };
}

async function getInventory(query = ""): Promise<Response> {
  return app.request(`/v1/policies${query}`, { headers: authHeaders() }, env);
}

describe("GET /v1/policies", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVNamespaces(env);
    await seedPolicyInventory();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVNamespaces(env);
  });

  it("returns wallet and API-key controls with summaries and redacted latest evaluations", async () => {
    const response = await getInventory();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PolicyControlInventoryResponse };

    expect(body.data).toMatchObject({
      total: 7,
      page: 1,
      pageSize: 25,
      summary: {
        total: 7,
        defaultAllow: 3,
        draft: 1,
        active: 2,
        disabled: 1,
        totalApiKeyBindings: 2,
      },
    });
    expect(new Set(body.data.controls.map((control) => control.targetType))).toEqual(
      new Set(["wallet", "api_key"])
    );
    expect(
      body.data.controls.every((control) => /^\d{4}-\d{2}-\d{2}T.*Z$/.test(control.updatedAt))
    ).toBe(true);

    const activeWallet = body.data.controls.find(
      (control) => control.targetId === "cw_policy_inventory_active"
    );
    expect(activeWallet).toMatchObject({
      targetType: "wallet",
      walletId: "wallet_policy_inventory_active",
      walletAddress: "address_policy_inventory_active",
      status: "active",
      activeRevisionId: "wcpr_policy_inventory_active",
      activeRevisionNumber: 2,
      defaultAction: "deny",
      ruleCount: 1,
      providerMappingStatus: "synced",
      latestEvaluation: {
        decision: "deny",
        evaluatedAt: "2026-07-15T02:01:00.000Z",
      },
    });

    const activeApiKey = body.data.controls.find(
      (control) => control.targetId === "key_policy_inventory_active"
    );
    expect(activeApiKey).toMatchObject({
      targetType: "api_key",
      apiKeyPrefix: "sk_test_treasury",
      status: "active",
      activeRevisionNumber: 3,
      defaultAction: "review",
      ruleCount: 2,
      bindingScope: "selected",
      selectedWalletCount: 2,
      latestEvaluation: {
        decision: "deny",
        evaluatedAt: "2026-07-15T02:01:00.000Z",
      },
    });

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("hash_policy_inventory_active");
    expect(serialized).not.toContain("must-not-leak");
    expect(serialized).not.toContain("Sensitive reason");
  });

  it("filters by target, display-name query, and status", async () => {
    const walletResponse = await getInventory("?target=wallet&query=dRaFt");
    expect(walletResponse.status).toBe(200);
    const walletBody = (await walletResponse.json()) as { data: PolicyControlInventoryResponse };
    expect(walletBody.data.controls).toHaveLength(1);
    expect(walletBody.data.controls[0]).toMatchObject({
      targetType: "wallet",
      displayName: "Draft Operations",
      status: "draft",
      activeRevisionId: null,
      activeRevisionNumber: null,
      defaultAction: "review",
      ruleCount: 2,
    });
    expect(walletBody.data.summary).toMatchObject({ total: 1, draft: 1 });

    const apiKeyResponse = await getInventory("?target=api_key&query=treasury&status=active");
    expect(apiKeyResponse.status).toBe(200);
    const apiKeyBody = (await apiKeyResponse.json()) as {
      data: PolicyControlInventoryResponse;
    };
    expect(apiKeyBody.data.total).toBe(1);
    expect(apiKeyBody.data.controls).toHaveLength(1);
    expect(apiKeyBody.data.controls[0]).toMatchObject({
      targetType: "api_key",
      displayName: "Treasury Automation",
      status: "active",
    });

    const disabledResponse = await getInventory("?status=disabled");
    const disabledBody = (await disabledResponse.json()) as {
      data: PolicyControlInventoryResponse;
    };
    expect(disabledBody.data.total).toBe(1);
    expect(disabledBody.data.controls[0]).toMatchObject({
      targetId: "cw_policy_inventory_disabled",
      status: "disabled",
    });
  });

  it("paginates deterministically and validates page size", async () => {
    const firstResponse = await getInventory("?page=1&pageSize=2");
    const firstBody = (await firstResponse.json()) as { data: PolicyControlInventoryResponse };
    expect(firstBody.data).toMatchObject({ total: 7, page: 1, pageSize: 2 });
    expect(firstBody.data.controls).toHaveLength(2);

    const lastResponse = await getInventory("?page=4&pageSize=2");
    const lastBody = (await lastResponse.json()) as { data: PolicyControlInventoryResponse };
    expect(lastBody.data.controls).toHaveLength(1);
    expect(lastBody.data.controls[0]?.targetId).not.toBe(firstBody.data.controls[0]?.targetId);

    const invalidResponse = await getInventory("?pageSize=101");
    expect(invalidResponse.status).toBe(400);
  });

  it("keeps organization, exact-project, and null scopes isolated", async () => {
    const response = await getInventory();
    const body = (await response.json()) as { data: PolicyControlInventoryResponse };
    const targetIds = body.data.controls.map((control) => control.targetId);
    expect(targetIds).not.toContain("cw_policy_inventory_null");
    expect(targetIds).not.toContain("cw_policy_inventory_other_project");
    expect(targetIds).not.toContain("cw_policy_inventory_foreign");
    expect(targetIds).not.toContain("key_policy_inventory_other_project");

    const nullScoped = await createPostgresPolicyRepository(getDb(env)).listPolicyControlInventory({
      organizationId: TEST_ORG_ID,
      projectId: null,
    });
    expect(nullScoped.total).toBe(1);
    expect(nullScoped.rows.map((row) => row.target_id)).toEqual(["cw_policy_inventory_null"]);
  });

  it("requires read access for every requested target family", async () => {
    const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(env, keyHash, cachedApiKey(["wallets:read"]));

    expect((await getInventory()).status).toBe(403);
    const walletsOnly = await getInventory("?target=wallet");
    expect(walletsOnly.status).toBe(200);
    const body = (await walletsOnly.json()) as { data: PolicyControlInventoryResponse };
    expect(body.data.controls.every((control) => control.targetType === "wallet")).toBe(true);
    expect((await getInventory("?target=api_key")).status).toBe(403);
  });

  it("returns only wallets readable through the calling API key scope", async () => {
    const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
    await seedCachedApiKey(
      env,
      keyHash,
      cachedApiKey(
        ["wallets:read"],
        [{ walletId: "wallet_policy_inventory_active", permissions: ["wallets:read"] }]
      )
    );

    const response = await getInventory("?target=wallet");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: PolicyControlInventoryResponse };
    expect(body.data.total).toBe(1);
    expect(body.data.controls.map((control) => control.targetId)).toEqual([
      "cw_policy_inventory_active",
    ]);
  });

  it("uses a fixed query count for any number of inventory targets", async () => {
    const db = getDb(env);
    let prepareCalls = 0;
    const countingDb = new Proxy(db, {
      get(target, property) {
        const value = Reflect.get(target, property);
        if (property === "prepare") {
          return (...args: Parameters<typeof db.prepare>) => {
            prepareCalls += 1;
            return db.prepare(...args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = await createPostgresPolicyRepository(countingDb).listPolicyControlInventory({
      organizationId: TEST_ORG_ID,
      projectId: TEST_PROJECT_ID,
      pageSize: 100,
    });
    expect(result.rows).toHaveLength(7);
    expect(prepareCalls).toBe(2);
  });
});
