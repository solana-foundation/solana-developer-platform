import { hashString } from "@sdp/payments/hash";
import type { CachedApiKey, PolicyEvaluationContext, WalletOperationFamily } from "@sdp/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import app from "@/index";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores, seedCachedApiKey } from "@/test/mocks/kv";

const TEST_ORG_ID = "org_policy_audit_routes";
const OTHER_ORG_ID = "org_policy_audit_other";
const TEST_PROJECT_ID = "prj_policy_audit_routes";
const OTHER_PROJECT_ID = "prj_policy_audit_other";
const TEST_USER_ID = "usr_policy_audit_routes";
const TEST_API_KEY = {
  id: "key_policy_audit_routes",
  raw: "sk_test_policy_audit_routes",
  prefix: "sk_test_par",
};
const TEST_CONFIG_ID = "cfg_policy_audit_routes";
const TEST_CUSTODY_WALLET_ID = "cw_policy_audit_routes";
const TEST_WALLET_ID = "wallet_policy_audit_routes";

const cachedApiKey: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG_ID,
  projectId: TEST_PROJECT_ID,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
};

let profileId = "";
let firstRevisionId = "";
let activeRevisionId = "";
let activeApiKeyRevisionId = "";
const evaluationIds = {
  allow: "",
  deny: "",
  review: "",
  foreign: "",
  crossOrganization: "",
};

function authHeaders() {
  return { Authorization: `Bearer ${TEST_API_KEY.raw}` };
}

function evaluationContext(input: {
  operationId: string;
  organizationId?: string;
  projectId: string;
  family: WalletOperationFamily;
  operationType: string;
  walletRevisionId: string | null;
  apiKeyRevisionId: string | null;
}): PolicyEvaluationContext {
  return {
    operation: {
      id: input.operationId,
      organizationId: input.organizationId ?? TEST_ORG_ID,
      projectId: input.projectId,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      apiKeyId: input.projectId === TEST_PROJECT_ID ? TEST_API_KEY.id : null,
      actor: { type: "api_key", id: TEST_API_KEY.id },
      source: "api",
      operationFamily: input.family,
      operationType: input.operationType,
      asset: "USDC",
      amount: "25.00",
      destination: "recipient_policy_audit",
      context: {
        requestId: `req_${input.operationId}`,
        clientSecret: "context-secret-value",
      },
      providerExtensions: {
        provider: "future-provider",
        apiKey: "provider-api-key-value",
      },
      idempotencyKey: null,
      rawPayload: {
        privateKey: "raw-private-key-value",
        providerPayload: { secret: "raw-provider-secret" },
      },
      createdAt: "2026-07-15T12:00:00.000Z",
    },
    walletPolicy: {
      source: input.walletRevisionId ? "customer_profile" : "implicit_default_allow",
      profileId: input.walletRevisionId ? profileId : null,
      revisionId: input.walletRevisionId,
      defaultAction: "allow",
      decision: "allow",
      requiresApproval: false,
    },
    apiKeyPolicy: input.apiKeyRevisionId
      ? {
          source: "customer_profile",
          profileId: "akcp_policy_audit_routes",
          revisionId: input.apiKeyRevisionId,
          defaultAction: "allow",
          decision: "allow",
          requiresApproval: false,
        }
      : null,
  };
}

async function seedAuthAndWallet() {
  const keyHash = await hashString(TEST_API_KEY.raw, env.API_KEY_PEPPER);
  await seedCachedApiKey(env, keyHash, cachedApiKey);

  await getDb(env).batch([
    getDb(env)
      .prepare(
        `INSERT INTO organizations (id, name, slug, tier, status)
         VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_ORG_ID,
        "Policy Audit Org",
        "policy-audit-org",
        "enterprise",
        "active",
        OTHER_ORG_ID,
        "Other Policy Audit Org",
        "other-policy-audit-org",
        "enterprise",
        "active"
      ),
    getDb(env)
      .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, ?, ?)")
      .bind(TEST_USER_ID, "policy-audit@example.com", 1, "active"),
    getDb(env)
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_PROJECT_ID,
        TEST_ORG_ID,
        "Policy Audit Project",
        "policy-audit-project",
        "sandbox",
        "active",
        TEST_USER_ID,
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
        `INSERT INTO api_keys
           (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_API_KEY.id,
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        TEST_USER_ID,
        "Policy audit key",
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
        TEST_CONFIG_ID,
        TEST_ORG_ID,
        TEST_PROJECT_ID,
        "local",
        "test-config",
        "sdp-custody-encryption-v1",
        TEST_WALLET_ID,
        "active"
      ),
    getDb(env)
      .prepare(
        `INSERT INTO custody_scope_defaults
           (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind("csd_policy_audit_routes", TEST_ORG_ID, TEST_PROJECT_ID, TEST_CONFIG_ID),
    getDb(env)
      .prepare(
        `INSERT INTO custody_wallets
           (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        TEST_CUSTODY_WALLET_ID,
        TEST_CONFIG_ID,
        TEST_WALLET_ID,
        "9wVmMF2GpxZMsJLxCv2xXWjDWVv8HtqTmKqnZxNKkYTz",
        "Policy Audit Wallet",
        "transfer",
        "active"
      ),
  ]);
}

async function seedPoliciesAndEvaluations() {
  const repository = createPostgresPolicyRepository(getDb(env));
  const profile = await repository.createWalletControlProfile({
    organizationId: TEST_ORG_ID,
    projectId: TEST_PROJECT_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    name: "Treasury controls",
    createdBy: TEST_USER_ID,
  });
  profileId = profile?.id ?? "";

  const firstRevision = await repository.createWalletControlProfileRevision({
    profileId,
    rules: [{ id: "allow-payments", kind: "operation_family", family: "payment" }],
    defaultAction: "allow",
    createdBy: TEST_USER_ID,
  });
  firstRevisionId = firstRevision?.id ?? "";
  await repository.activateWalletControlProfileRevision({
    profileId,
    revisionId: firstRevisionId,
    activatedAt: "2026-07-15T10:00:00.000Z",
  });

  const activeRevision = await repository.createWalletControlProfileRevision({
    profileId,
    rules: [{ id: "review-ramps", kind: "operation_family", family: "ramp" }],
    defaultAction: "review",
    createdBy: TEST_USER_ID,
  });
  activeRevisionId = activeRevision?.id ?? "";
  await repository.activateWalletControlProfileRevision({
    profileId,
    revisionId: activeRevisionId,
    activatedAt: "2026-07-15T11:00:00.000Z",
  });

  const apiKeyProfile = await repository.createApiKeyControlProfile({
    organizationId: TEST_ORG_ID,
    projectId: TEST_PROJECT_ID,
    apiKeyId: TEST_API_KEY.id,
    name: "Caller controls",
    createdBy: TEST_USER_ID,
  });
  const apiKeyRevision = await repository.createApiKeyControlProfileRevision({
    profileId: apiKeyProfile?.id ?? "",
    rules: [{ id: "allow-caller", kind: "always" }],
    defaultAction: "allow",
  });
  activeApiKeyRevisionId = apiKeyRevision?.id ?? "";
  await repository.activateApiKeyControlProfileRevision({
    profileId: apiKeyProfile?.id ?? "",
    revisionId: activeApiKeyRevisionId,
  });

  const evaluations = [
    {
      key: "allow" as const,
      operationId: "wop_policy_audit_allow",
      family: "payment" as const,
      operationType: "payment_transfer",
      status: "completed" as const,
      decision: "allow" as const,
      reasonCode: "wallet_policy_match",
      reason: "Payment matched the active allow rule.",
      createdAt: "2026-07-15T12:01:00.000Z",
      revisionId: firstRevisionId,
      approvalRequestId: null,
    },
    {
      key: "deny" as const,
      operationId: "wop_policy_audit_deny",
      family: "payment" as const,
      operationType: "payment_transfer",
      status: "failed" as const,
      decision: "deny" as const,
      reasonCode: "wallet_policy_match",
      reason: "Payment matched a deny rule.",
      createdAt: "2026-07-15T12:02:00.000Z",
      revisionId: activeRevisionId,
      approvalRequestId: null,
    },
    {
      key: "review" as const,
      operationId: "wop_policy_audit_review",
      family: "ramp" as const,
      operationType: "onramp_quote",
      status: "pending_approval" as const,
      decision: "review" as const,
      reasonCode: "manual_review",
      reason: "Ramp operation requires operator review.",
      createdAt: "2026-07-15T12:03:00.000Z",
      revisionId: activeRevisionId,
      approvalRequestId: "appr_policy_audit_review",
    },
  ];

  for (const entry of evaluations) {
    const operation = await repository.createWalletOperation({
      organizationId: TEST_ORG_ID,
      projectId: TEST_PROJECT_ID,
      custodyWalletId: TEST_CUSTODY_WALLET_ID,
      walletId: TEST_WALLET_ID,
      apiKeyId: TEST_API_KEY.id,
      operationFamily: entry.family,
      operationType: entry.operationType,
      asset: "USDC",
      amount: "25.00",
      destination: "recipient_policy_audit",
      status: entry.status,
    });
    await getDb(env)
      .prepare("UPDATE wallet_operations SET created_at = ?, updated_at = ? WHERE id = ?")
      .bind(entry.createdAt, entry.createdAt, operation?.id)
      .run();

    if (entry.approvalRequestId) {
      await getDb(env)
        .prepare(
          `INSERT INTO approval_requests
             (id, organization_id, project_id, wallet_operation_id, status, provider_payload)
           VALUES (?, ?, ?, ?, ?, ?::jsonb)`
        )
        .bind(
          entry.approvalRequestId,
          TEST_ORG_ID,
          TEST_PROJECT_ID,
          operation?.id,
          "pending",
          JSON.stringify({ secret: "provider-approval-secret" })
        )
        .run();
    }

    const evaluation = await repository.createPolicyEvaluation({
      walletOperationId: operation?.id ?? "",
      walletPolicyRevisionId: entry.revisionId,
      apiKeyPolicyRevisionId: activeApiKeyRevisionId,
      decision: entry.decision,
      reasonCode: entry.reasonCode,
      reason: entry.reason,
      matchedRules: [
        {
          ruleId: `${entry.key}-rule`,
          kind: "operation_family",
          privateKey: "matched-rule-private-key",
        },
      ],
      evaluationContext: evaluationContext({
        operationId: operation?.id ?? "",
        projectId: TEST_PROJECT_ID,
        family: entry.family,
        operationType: entry.operationType,
        walletRevisionId: entry.revisionId,
        apiKeyRevisionId: activeApiKeyRevisionId,
      }),
      requiresApproval: Boolean(entry.approvalRequestId),
      approvalRequestId: entry.approvalRequestId,
    });
    evaluationIds[entry.key] = evaluation?.id ?? "";
    await getDb(env)
      .prepare("UPDATE policy_evaluations SET created_at = ? WHERE id = ?")
      .bind(entry.createdAt, evaluation?.id)
      .run();
  }

  const foreignOperation = await repository.createWalletOperation({
    organizationId: TEST_ORG_ID,
    projectId: OTHER_PROJECT_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    operationFamily: "payment",
    operationType: "foreign_project_payment",
  });
  const foreignEvaluation = await repository.createPolicyEvaluation({
    walletOperationId: foreignOperation?.id ?? "",
    decision: "allow",
    reasonCode: "implicit_default_allow",
    evaluationContext: evaluationContext({
      operationId: foreignOperation?.id ?? "",
      projectId: OTHER_PROJECT_ID,
      family: "payment",
      operationType: "foreign_project_payment",
      walletRevisionId: null,
      apiKeyRevisionId: null,
    }),
  });
  evaluationIds.foreign = foreignEvaluation?.id ?? "";

  const crossOrganizationOperation = await repository.createWalletOperation({
    organizationId: OTHER_ORG_ID,
    projectId: TEST_PROJECT_ID,
    custodyWalletId: TEST_CUSTODY_WALLET_ID,
    walletId: TEST_WALLET_ID,
    operationFamily: "payment",
    operationType: "foreign_organization_payment",
  });
  const crossOrganizationEvaluation = await repository.createPolicyEvaluation({
    walletOperationId: crossOrganizationOperation?.id ?? "",
    decision: "allow",
    reasonCode: "implicit_default_allow",
    evaluationContext: evaluationContext({
      operationId: crossOrganizationOperation?.id ?? "",
      organizationId: OTHER_ORG_ID,
      projectId: TEST_PROJECT_ID,
      family: "payment",
      operationType: "foreign_organization_payment",
      walletRevisionId: null,
      apiKeyRevisionId: null,
    }),
  });
  evaluationIds.crossOrganization = crossOrganizationEvaluation?.id ?? "";
}

describe("Wallet policy audit detail routes", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedAuthAndWallet();
    await seedPoliciesAndEvaluations();
  });

  afterEach(async () => {
    await clearTestDatabase(env);
    await clearKVStores(env);
  });

  it("lists immutable control profile revisions and marks the active revision", async () => {
    const response = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/revisions`,
      { headers: authHeaders() },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        profile: { id: string; activeRevisionId: string };
        revisions: Array<{ id: string; revisionNumber: number; isActive: boolean }>;
      };
    };
    expect(body.data.profile).toMatchObject({ id: profileId, activeRevisionId });
    expect(body.data.revisions).toEqual([
      expect.objectContaining({ id: activeRevisionId, revisionNumber: 2, isActive: true }),
      expect.objectContaining({ id: firstRevisionId, revisionNumber: 1, isActive: false }),
    ]);
  });

  it("returns one evaluation with decision context, status, revisions, and approval linkage", async () => {
    const response = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations/${evaluationIds.review}`,
      { headers: authHeaders() },
      env
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { data: { policyEvaluation: Record<string, unknown> } };
    expect(body.data.policyEvaluation).toMatchObject({
      id: evaluationIds.review,
      walletOperation: {
        operationFamily: "ramp",
        operationType: "onramp_quote",
        status: "pending_approval",
      },
      policyRevisions: {
        wallet: {
          evaluatedRevisionId: activeRevisionId,
          activeRevisionId,
        },
        apiKey: {
          evaluatedRevisionId: activeApiKeyRevisionId,
          activeRevisionId: activeApiKeyRevisionId,
        },
      },
      decision: "review",
      reasonCode: "manual_review",
      reason: "Ramp operation requires operator review.",
      requiresApproval: true,
      approvalRequestId: "appr_policy_audit_review",
    });
  });

  it("paginates and filters wallet evaluation history", async () => {
    const pageResponse = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations?page=1&pageSize=2`,
      { headers: authHeaders() },
      env
    );
    expect(pageResponse.status).toBe(200);
    const pageBody = (await pageResponse.json()) as {
      data: Array<{ id: string }>;
      meta: { total: number; page: number; pageSize: number; hasMore: boolean };
    };
    expect(pageBody.data.map((item) => item.id)).toEqual([
      evaluationIds.review,
      evaluationIds.deny,
    ]);
    expect(pageBody.meta).toMatchObject({ total: 3, page: 1, pageSize: 2, hasMore: true });

    const filteredResponse = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations?decision=deny&status=failed&operationFamily=payment`,
      { headers: authHeaders() },
      env
    );
    expect(filteredResponse.status).toBe(200);
    const filteredBody = (await filteredResponse.json()) as {
      data: Array<{ id: string; decision: string }>;
      meta: { total: number };
    };
    expect(filteredBody.data).toEqual([
      expect.objectContaining({ id: evaluationIds.deny, decision: "deny" }),
    ]);
    expect(filteredBody.meta.total).toBe(1);
  });

  it("rejects unauthenticated reads and hides cross-project and cross-organization evaluations", async () => {
    const unauthenticated = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations`,
      undefined,
      env
    );
    expect(unauthenticated.status).toBe(401);

    const crossProject = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations/${evaluationIds.foreign}`,
      { headers: authHeaders() },
      env
    );
    expect(crossProject.status).toBe(404);

    const crossOrganization = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations/${evaluationIds.crossOrganization}`,
      { headers: authHeaders() },
      env
    );
    expect(crossOrganization.status).toBe(404);
  });

  it("redacts credential fields and never returns raw or provider payloads", async () => {
    const response = await app.request(
      `/v1/payments/wallets/${TEST_WALLET_ID}/policies/evaluations/${evaluationIds.review}`,
      { headers: authHeaders() },
      env
    );
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      data: {
        policyEvaluation: {
          matchedRules: Array<Record<string, unknown>>;
          evaluationContext: { operation: Record<string, unknown> };
        };
      };
    };
    const evaluation = body.data.policyEvaluation;
    expect(evaluation.matchedRules[0]?.privateKey).toBe("[REDACTED]");
    expect(evaluation.evaluationContext.operation).not.toHaveProperty("rawPayload");
    expect(evaluation.evaluationContext.operation).not.toHaveProperty("providerExtensions");
    expect(evaluation.evaluationContext.operation.context).toMatchObject({
      clientSecret: "[REDACTED]",
    });
    expect(JSON.stringify(evaluation)).not.toContain("provider-approval-secret");
    expect(JSON.stringify(evaluation)).not.toContain("raw-private-key-value");
    expect(JSON.stringify(evaluation)).not.toContain("provider-api-key-value");
  });
});
