import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { ApiKeyService } from "@/services/api-key.service";
import { PolicyFoundationService } from "@/services/policy-foundation.service";
import { TEST_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_CUSTODY_CONFIG, TEST_CUSTODY_WALLET } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { PolicyRepository } from "./policy.repository";
import { createPostgresPolicyRepository } from "./policy.repository.postgres";

describe("PolicyRepository (postgres)", () => {
  let repo: PolicyRepository;

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
    await seedPolicyFoundationFixtures();
    repo = createPostgresPolicyRepository(getDb(env));
  });

  it("resolves implicit default allow when no customer-authored profiles exist", async () => {
    const service = new PolicyFoundationService(repo);

    await expect(
      service.resolveEffectiveWalletPolicy(TEST_CUSTODY_WALLET.id)
    ).resolves.toMatchObject({
      source: "implicit_default_allow",
      profile: null,
      revision: null,
      defaultAction: "allow",
    });

    await expect(service.resolveEffectiveApiKeyPolicy(TEST_API_KEY.id)).resolves.toMatchObject({
      source: "implicit_default_allow",
      profile: null,
      revision: null,
      defaultAction: "allow",
    });
  });

  it("stores wallet profile revisions as insert-only rows and changes active revision explicitly", async () => {
    const profile = await repo.createWalletControlProfile({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      name: "Treasury controls",
      createdBy: TEST_USER.id,
    });
    expect(profile).not.toBeNull();

    const revision1 = await repo.createWalletControlProfileRevision({
      profileId: profile?.id ?? "",
      rules: [{ kind: "operation_family", family: "payment" }],
      defaultAction: "allow",
      createdBy: TEST_USER.id,
    });
    const activated1 = await repo.activateWalletControlProfileRevision({
      profileId: profile?.id ?? "",
      revisionId: revision1?.id ?? "",
      activatedAt: "2026-06-17T00:00:00.000Z",
    });
    expect(activated1?.profile.active_revision_id).toBe(revision1?.id);

    const revision2 = await repo.createWalletControlProfileRevision({
      profileId: profile?.id ?? "",
      rules: [{ kind: "destination", allowlist: ["recipient_1"] }],
      defaultAction: "review",
      createdBy: TEST_USER.id,
    });
    expect(revision2?.revision_number).toBe(2);

    const activeBefore = await repo.getActiveWalletControlProfileByCustodyWalletId(
      TEST_CUSTODY_WALLET.id
    );
    expect(activeBefore?.revision?.id).toBe(revision1?.id);

    const activated2 = await repo.activateWalletControlProfileRevision({
      profileId: profile?.id ?? "",
      revisionId: revision2?.id ?? "",
      activatedAt: "2026-06-17T01:00:00.000Z",
    });
    expect(activated2?.profile.active_revision_id).toBe(revision2?.id);

    const persistedRevision1 = await getDb(env)
      .prepare("SELECT rules, default_action FROM wallet_control_profile_revisions WHERE id = ?")
      .bind(revision1?.id)
      .first<{ rules: Record<string, unknown>[]; default_action: string }>();
    expect(persistedRevision1?.rules).toEqual([{ kind: "operation_family", family: "payment" }]);
    expect(persistedRevision1?.default_action).toBe("allow");
  });

  it("returns null when creating revisions for missing profiles", async () => {
    await expect(
      repo.createWalletControlProfileRevision({
        profileId: "wcp_missing",
        rules: [{ kind: "amount", max: "10" }],
      })
    ).resolves.toBeNull();

    await expect(
      repo.createApiKeyControlProfileRevision({
        profileId: "akcp_missing",
        rules: [{ kind: "destination", allowlist: ["recipient_1"] }],
      })
    ).resolves.toBeNull();
  });

  it("records wallet operations and policy evaluations with revision references", async () => {
    const walletProfile = await repo.createWalletControlProfile({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      name: "Payment controls",
      createdBy: TEST_USER.id,
    });
    const walletRevision = await repo.createWalletControlProfileRevision({
      profileId: walletProfile?.id ?? "",
      rules: [{ kind: "amount", max: "100" }],
    });
    await repo.activateWalletControlProfileRevision({
      profileId: walletProfile?.id ?? "",
      revisionId: walletRevision?.id ?? "",
    });

    const apiKeyProfile = await repo.createApiKeyControlProfile({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      apiKeyId: TEST_API_KEY.id,
      name: "Payment key controls",
      createdBy: TEST_USER.id,
    });
    const apiKeyRevision = await repo.createApiKeyControlProfileRevision({
      profileId: apiKeyProfile?.id ?? "",
      rules: [{ kind: "destination", allowlist: ["recipient_1"] }],
    });
    await repo.activateApiKeyControlProfileRevision({
      profileId: apiKeyProfile?.id ?? "",
      revisionId: apiKeyRevision?.id ?? "",
    });

    const operation = await repo.createWalletOperation({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      walletId: TEST_CUSTODY_WALLET.walletId,
      apiKeyId: TEST_API_KEY.id,
      actor: { type: "api_key", id: TEST_API_KEY.id, apiKeyId: TEST_API_KEY.id },
      operationFamily: "payment",
      operationType: "payment_request",
      asset: "USDC",
      amount: "12.50",
      destination: "recipient_1",
      context: { requestId: "req_policy_1" },
      providerExtensions: { provider: "future-provider" },
      rawPayload: { paymentRequestId: "payreq_1" },
    });
    expect(operation?.raw_payload).toEqual({
      paymentRequestId: "payreq_1",
      actor: { type: "api_key", id: TEST_API_KEY.id, apiKeyId: TEST_API_KEY.id },
      context: { requestId: "req_policy_1" },
      providerExtensions: { provider: "future-provider" },
    });
    const evaluationContext = {
      operation: {
        id: operation?.id ?? "",
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        custodyWalletId: TEST_CUSTODY_WALLET.id,
        walletId: TEST_CUSTODY_WALLET.walletId,
        apiKeyId: TEST_API_KEY.id,
        actor: { type: "api_key", id: TEST_API_KEY.id, apiKeyId: TEST_API_KEY.id },
        source: "api",
        operationFamily: "payment" as const,
        operationType: "payment_request",
        asset: "USDC",
        amount: "12.50",
        destination: "recipient_1",
        context: { requestId: "req_policy_1" },
        providerExtensions: { provider: "future-provider" },
        idempotencyKey: null,
        rawPayload: {
          paymentRequestId: "payreq_1",
          actor: { type: "api_key", id: TEST_API_KEY.id, apiKeyId: TEST_API_KEY.id },
          context: { requestId: "req_policy_1" },
          providerExtensions: { provider: "future-provider" },
        },
        createdAt: operation?.created_at ?? "",
      },
      walletPolicy: {
        source: "customer_profile" as const,
        profileId: walletProfile?.id ?? null,
        revisionId: walletRevision?.id ?? null,
        defaultAction: "allow" as const,
        decision: "allow" as const,
        requiresApproval: false,
      },
      apiKeyPolicy: {
        source: "customer_profile" as const,
        profileId: apiKeyProfile?.id ?? null,
        revisionId: apiKeyRevision?.id ?? null,
        defaultAction: "allow" as const,
        decision: "allow" as const,
        requiresApproval: false,
      },
    };

    const evaluation = await repo.createPolicyEvaluation({
      walletOperationId: operation?.id ?? "",
      walletPolicyRevisionId: walletRevision?.id,
      apiKeyPolicyRevisionId: apiKeyRevision?.id,
      decision: "allow",
      reasonCode: "wallet_policy_match",
      matchedRules: [{ ruleId: "amount-limit" }],
      evaluationContext,
    });

    expect(evaluation).toMatchObject({
      wallet_operation_id: operation?.id,
      wallet_policy_revision_id: walletRevision?.id,
      api_key_policy_revision_id: apiKeyRevision?.id,
      decision: "allow",
      reason_code: "wallet_policy_match",
      matched_rules: [{ ruleId: "amount-limit" }],
      evaluation_context: evaluationContext,
    });
  });

  it("maps legacy policy evaluation rows without a structured context to null", async () => {
    const operation = await repo.createWalletOperation({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      walletId: TEST_CUSTODY_WALLET.walletId,
      operationFamily: "transfer",
      operationType: "legacy_transfer",
    });
    expect(operation).not.toBeNull();

    await getDb(env)
      .prepare(
        `INSERT INTO policy_evaluations (
           id,
           wallet_operation_id,
           decision,
           reason_code,
           matched_rules,
           evaluation_context
         ) VALUES (?, ?, ?, ?, ?::jsonb, ?::jsonb)`
      )
      .bind("peval_legacy_context", operation?.id, "allow", "legacy_policy_evaluation", "[]", "{}")
      .run();

    const evaluations = await repo.listPolicyEvaluationsForOperation(operation?.id ?? "");

    expect(evaluations).toHaveLength(1);
    expect(evaluations[0]?.evaluation_context).toBeNull();
  });

  it("preserves an explicit null wallet operation actor through service mapping", async () => {
    const service = new PolicyFoundationService(repo);

    const operation = await service.recordWalletOperation({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      walletId: TEST_CUSTODY_WALLET.walletId,
      apiKeyId: TEST_API_KEY.id,
      actor: null,
      operationFamily: "program",
      operationType: "program_call",
      rawPayload: { programId: "program_1" },
    });

    expect(operation).toMatchObject({
      apiKeyId: TEST_API_KEY.id,
      actor: null,
      rawPayload: {
        programId: "program_1",
        actor: null,
      },
    });
  });

  it("stores policy-scoped wallet bindings separately from endpoint wallet permissions", async () => {
    const apiKeyProfile = await repo.createApiKeyControlProfile({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      apiKeyId: TEST_API_KEY.id,
      name: "Selected wallet controls",
    });

    const binding = await repo.upsertApiKeyWalletPolicyBinding({
      apiKeyId: TEST_API_KEY.id,
      bindingScope: "selected",
      walletId: TEST_CUSTODY_WALLET.walletId,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      apiKeyControlProfileId: apiKeyProfile?.id,
    });
    expect(binding?.api_key_control_profile_id).toBe(apiKeyProfile?.id);

    await repo.upsertApiKeyWalletPolicyBinding({
      apiKeyId: TEST_API_KEY.id,
      bindingScope: "selected",
      walletId: TEST_CUSTODY_WALLET.walletId,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      apiKeyControlProfileId: null,
    });

    const bindings = await repo.listApiKeyWalletPolicyBindings(TEST_API_KEY.id);
    expect(bindings).toHaveLength(1);
    expect(bindings[0]).toMatchObject({
      binding_scope: "selected",
      wallet_id: TEST_CUSTODY_WALLET.walletId,
      custody_wallet_id: TEST_CUSTODY_WALLET.id,
      api_key_control_profile_id: null,
    });
  });

  it("rejects policy wallet bindings that do not match their scope before querying Postgres", async () => {
    const selectedWithoutWalletId = {
      apiKeyId: TEST_API_KEY.id,
      bindingScope: "selected",
    } as const;

    await expect(
      // @ts-expect-error selected policy bindings require a wallet ID at compile time.
      repo.upsertApiKeyWalletPolicyBinding(selectedWithoutWalletId)
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "walletId is required for selected API key wallet policy bindings",
    });

    const selectedWithNullWalletId = {
      apiKeyId: TEST_API_KEY.id,
      bindingScope: "selected",
      walletId: null,
    } as const;

    await expect(
      // @ts-expect-error selected policy bindings require a non-null wallet ID.
      repo.upsertApiKeyWalletPolicyBinding(selectedWithNullWalletId)
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "walletId is required for selected API key wallet policy bindings",
    });

    const allWithWalletTarget = {
      apiKeyId: TEST_API_KEY.id,
      bindingScope: "all",
      walletId: TEST_CUSTODY_WALLET.walletId,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
    } as const;

    await expect(
      // @ts-expect-error all-wallet policy bindings cannot carry a selected-wallet target.
      repo.upsertApiKeyWalletPolicyBinding(allWithWalletTarget)
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "walletId and custodyWalletId must be omitted for all-wallet policy bindings",
    });

    const bindings = await repo.listApiKeyWalletPolicyBindings(TEST_API_KEY.id);
    expect(bindings).toHaveLength(0);
  });

  it("preserves policy-scoped wallet bindings when an API key is rotated", async () => {
    await getDb(env)
      .prepare(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_rotate_policy_test', ?, ?, '["payments:write"]')`
      )
      .bind(TEST_API_KEY.id, TEST_CUSTODY_WALLET.walletId)
      .run();

    const apiKeyProfile = await repo.createApiKeyControlProfile({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      apiKeyId: TEST_API_KEY.id,
      name: "Rotation controls",
      createdBy: TEST_USER.id,
    });
    const apiKeyRevision = await repo.createApiKeyControlProfileRevision({
      profileId: apiKeyProfile?.id ?? "",
      rules: [{ kind: "destination", allowlist: ["recipient_1"] }],
      defaultAction: "review",
      createdBy: TEST_USER.id,
    });
    await repo.activateApiKeyControlProfileRevision({
      profileId: apiKeyProfile?.id ?? "",
      revisionId: apiKeyRevision?.id ?? "",
    });
    await repo.upsertApiKeyWalletPolicyBinding({
      apiKeyId: TEST_API_KEY.id,
      bindingScope: "selected",
      walletId: TEST_CUSTODY_WALLET.walletId,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      apiKeyControlProfileId: apiKeyProfile?.id,
    });

    const rotation = await new ApiKeyService(getDb(env)).rotateApiKey(
      TEST_API_KEY.id,
      TEST_ORG.id,
      TEST_PROJECT.id,
      24,
      "pepper"
    );
    expect(rotation).not.toBeNull();

    const clonedBindings = await repo.listApiKeyWalletPolicyBindings(rotation?.apiKey.id ?? "");
    expect(clonedBindings).toHaveLength(1);
    expect(clonedBindings[0].wallet_id).toBe(TEST_CUSTODY_WALLET.walletId);
    expect(clonedBindings[0].api_key_control_profile_id).not.toBe(apiKeyProfile?.id);

    const clonedProfile = await repo.getActiveApiKeyControlProfileByApiKeyId(
      rotation?.apiKey.id ?? ""
    );
    expect(clonedProfile?.profile.name).toBe("Rotation controls");
    expect(clonedProfile?.revision?.rules).toEqual([
      { kind: "destination", allowlist: ["recipient_1"] },
    ]);
    expect(clonedBindings[0].api_key_control_profile_id).toBe(clonedProfile?.profile.id);

    const clonedEndpointPermissions = await getDb(env)
      .prepare("SELECT permissions FROM api_key_wallet_permissions WHERE api_key_id = ?")
      .bind(rotation?.apiKey.id)
      .all<{ permissions: string }>();
    expect(clonedEndpointPermissions.results).toHaveLength(1);
    expect(JSON.parse(clonedEndpointPermissions.results[0].permissions)).toEqual([
      "payments:write",
    ]);
  });
});

async function seedPolicyFoundationFixtures(): Promise<void> {
  const db = getDb(env);

  await db
    .prepare(
      "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
    )
    .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
    .run();

  await db
    .prepare("INSERT INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')")
    .bind(TEST_USER.id, TEST_USER.email)
    .run();

  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`
    )
    .bind(
      TEST_PROJECT.id,
      TEST_ORG.id,
      TEST_PROJECT.name,
      TEST_PROJECT.slug,
      TEST_PROJECT.environment,
      TEST_USER.id
    )
    .run();

  await db
    .prepare(
      `INSERT INTO api_keys (
         id,
         organization_id,
         project_id,
         created_by,
         name,
         key_prefix,
         key_hash,
         role,
         permissions,
         status
       ) VALUES (?, ?, ?, ?, 'Test key', ?, 'hash_policy_foundation', 'api_admin', '["*"]', 'active')`
    )
    .bind(TEST_API_KEY.id, TEST_ORG.id, TEST_PROJECT.id, TEST_USER.id, TEST_API_KEY.prefix)
    .run();

  await db
    .prepare(
      `INSERT INTO custody_configs (
         id,
         organization_id,
         project_id,
         provider,
         config_encrypted,
         default_wallet_id,
         status
       ) VALUES (?, ?, ?, 'local', 'encrypted', ?, 'active')`
    )
    .bind(TEST_CUSTODY_CONFIG.id, TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET.walletId)
    .run();

  await db
    .prepare(
      `INSERT INTO custody_wallets (
         id,
         custody_config_id,
         wallet_id,
         public_key,
         label,
         purpose,
         status
       ) VALUES (?, ?, ?, ?, ?, ?, 'active')`
    )
    .bind(
      TEST_CUSTODY_WALLET.id,
      TEST_CUSTODY_CONFIG.id,
      TEST_CUSTODY_WALLET.walletId,
      TEST_CUSTODY_WALLET.publicKey,
      TEST_CUSTODY_WALLET.label,
      TEST_CUSTODY_WALLET.purpose
    )
    .run();
}
