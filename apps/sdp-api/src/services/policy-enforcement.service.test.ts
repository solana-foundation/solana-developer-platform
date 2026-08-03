import type { PolicyDefaultAction, PolicyRule } from "@sdp/types";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb } from "@/db";
import {
  type ActiveWalletControlProfileResult,
  type ApprovalRequestRow,
  type CreatePolicyEvaluationInput,
  type CreateWalletOperationInput,
  createPostgresPolicyRepository,
  type PolicyRepository,
  type WalletOperationRow,
} from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createTenantScope, TenantScopeViolationError } from "@/lib/tenant-scope";
import { PolicyFoundationService } from "@/services/policy-foundation.service";
import { TEST_API_KEY } from "@/test/fixtures/api-keys";
import { TEST_CUSTODY_CONFIG, TEST_CUSTODY_WALLET } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { Env } from "@/types/env";
import {
  enforceWalletOperationPolicy,
  WalletPolicyEnforcementService,
} from "./policy-enforcement.service";

const baseOperation: CreateWalletOperationInput = {
  organizationId: "org_1",
  projectId: "prj_1",
  custodyWalletId: "cw_1",
  walletId: "wal_1",
  apiKeyId: "key_1",
  actor: { type: "api_key", id: "key_1", apiKeyId: "key_1" },
  operationFamily: "payment",
  operationType: "payment_transfer",
  asset: "USDC",
  amount: "25.00",
  destination: "recipient_1",
  rawPayload: { requestId: "req_1" },
};

function walletProfile(
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): ActiveWalletControlProfileResult {
  return {
    profile: {
      id: "wcp_1",
      organization_id: "org_1",
      project_id: "prj_1",
      custody_wallet_id: "cw_1",
      name: "Wallet controls",
      status: "active",
      active_revision_id: "wcpr_1",
      created_by: "usr_1",
      created_at: "2026-06-18T00:00:00.000Z",
      updated_at: "2026-06-18T00:00:00.000Z",
      activated_at: "2026-06-18T00:00:00.000Z",
      archived_at: null,
    },
    revision: {
      id: "wcpr_1",
      profile_id: "wcp_1",
      revision_number: 1,
      rules: rules as unknown as Record<string, unknown>[],
      default_action: defaultAction,
      created_by: "usr_1",
      created_at: "2026-06-18T00:00:00.000Z",
      activated_at: "2026-06-18T00:00:00.000Z",
    },
  };
}

function createRepository(options: {
  walletPolicy?: ActiveWalletControlProfileResult | null;
  existingApprovalRequestStatus?: ApprovalRequestRow["status"];
}) {
  const operations: WalletOperationRow[] = [];
  const approvalRequests: ApprovalRequestRow[] = [];

  const repository = {
    createWalletOperation: vi.fn(async (input: CreateWalletOperationInput) => {
      const row: WalletOperationRow = {
        id: `wop_${operations.length + 1}`,
        organization_id: input.organizationId,
        project_id: input.projectId,
        custody_wallet_id: input.custodyWalletId ?? null,
        wallet_id: input.walletId,
        api_key_id: input.apiKeyId ?? null,
        source: input.source ?? "api",
        operation_family: input.operationFamily,
        operation_type: input.operationType,
        asset: input.asset ?? null,
        amount: input.amount ?? null,
        destination: input.destination ?? null,
        raw_payload: {
          ...(input.rawPayload ?? {}),
          ...(input.actor !== undefined ? { actor: input.actor } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.providerExtensions ? { providerExtensions: input.providerExtensions } : {}),
        },
        idempotency_key: input.idempotencyKey ?? null,
        status: input.status ?? "created",
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
      operations.push(row);
      return row;
    }),
    updateWalletOperationStatus: vi.fn(async (walletOperationId: string, status: string) => {
      const operation = operations.find((row) => row.id === walletOperationId);
      if (!operation) return null;
      operation.status = status as WalletOperationRow["status"];
      operation.updated_at = "2026-06-18T00:01:00.000Z";
      return operation;
    }),
    createPolicyEvaluation: vi.fn(async (input: CreatePolicyEvaluationInput) => ({
      id: "peval_1",
      wallet_operation_id: input.walletOperationId,
      wallet_policy_revision_id: input.walletPolicyRevisionId ?? null,
      api_key_policy_revision_id: input.apiKeyPolicyRevisionId ?? null,
      decision: input.decision,
      reason_code: input.reasonCode,
      reason: input.reason ?? null,
      matched_rules: input.matchedRules ?? [],
      evaluation_context: input.evaluationContext,
      requires_approval: input.requiresApproval ?? false,
      approval_request_id: input.approvalRequestId ?? null,
      created_at: "2026-06-18T00:00:00.000Z",
    })),
    createApprovalRequest: vi.fn(async (input) => {
      if (options.existingApprovalRequestStatus) {
        const row: ApprovalRequestRow = {
          id: "appr_existing",
          organization_id: input.organizationId,
          project_id: input.projectId,
          wallet_operation_id: input.walletOperationId,
          approval_group_id: input.approvalGroupId ?? null,
          status: options.existingApprovalRequestStatus,
          provider: input.provider ?? null,
          provider_reference: input.providerReference ?? null,
          provider_payload: input.providerPayload ?? {},
          requested_by: input.requestedBy ?? null,
          resolved_by: "usr_previous",
          expires_at: input.expiresAt ?? null,
          resolved_at: "2026-06-18T00:02:00.000Z",
          created_at: "2026-06-18T00:00:00.000Z",
          updated_at: "2026-06-18T00:02:00.000Z",
        };
        approvalRequests.push(row);
        return row;
      }

      const row: ApprovalRequestRow = {
        id: `appr_${approvalRequests.length + 1}`,
        organization_id: input.organizationId,
        project_id: input.projectId,
        wallet_operation_id: input.walletOperationId,
        approval_group_id: input.approvalGroupId ?? null,
        status: "pending",
        provider: input.provider ?? null,
        provider_reference: input.providerReference ?? null,
        provider_payload: input.providerPayload ?? {},
        requested_by: input.requestedBy ?? null,
        resolved_by: null,
        expires_at: input.expiresAt ?? null,
        resolved_at: null,
        created_at: "2026-06-18T00:00:00.000Z",
        updated_at: "2026-06-18T00:00:00.000Z",
      };
      approvalRequests.push(row);
      return row;
    }),
    updateApprovalRequestStatus: vi.fn(async () => null),
    listPolicyEvaluationsForOperation: vi.fn(async () => []),
    getActiveWalletControlProfileByCustodyWalletId: vi.fn(async () => options.walletPolicy ?? null),
    getActiveApiKeyControlProfileByApiKeyId: vi.fn(async () => null),
    getApiKeyWalletPolicyBindingResolution: vi.fn(async () => ({
      total_binding_count: 0,
      binding: null,
    })),
  } as unknown as PolicyRepository;

  return repository;
}

/**
 * Awaits a policy-enforcement promise and asserts it rejects with the
 * transactional decision error shape (thrown only after the underlying
 * transaction has committed).
 *
 * @param promise - The pending `enforceWalletOperationPolicy` call.
 * @param code - The expected decision error code.
 * @returns The rejected `AppError`, for reading its `details`.
 */
async function expectPolicyDecisionError(
  promise: Promise<unknown>,
  code: "FORBIDDEN" | "SIGNING_PENDING"
): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe(code);
    return appError;
  }
  throw new Error(`Expected policy enforcement to reject with ${code}`);
}

/**
 * Reads a required string field off a decision error's details, failing
 * loudly rather than defaulting when the field is missing or the wrong type.
 *
 * @param error - The decision error returned by `expectPolicyDecisionError`.
 * @param key - The details field to read.
 * @returns The field's string value.
 */
function requireStringDetail(error: AppError, key: string): string {
  if (!error.details) {
    throw new Error(`Expected policy decision error to include details.${key}`);
  }
  const value = error.details[key];
  if (typeof value !== "string") {
    throw new Error(`Expected policy decision error details.${key} to be a string`);
  }
  return value;
}

describe("WalletPolicyEnforcementService", () => {
  it("rejects operation tenant claims that differ from the trusted request scope", async () => {
    const scope = createTenantScope({ organizationId: "org_1", projectId: "prj_1" });

    await expect(
      enforceWalletOperationPolicy({} as Env, scope, {
        ...baseOperation,
        organizationId: "org_foreign",
        projectId: "prj_foreign",
      })
    ).rejects.toBeInstanceOf(TenantScopeViolationError);
  });

  describe("with a mocked repository", () => {
    it("records default-allow operations and marks them evaluated", async () => {
      const repository = createRepository({});
      const service = new WalletPolicyEnforcementService(repository);

      const result = await service.enforce(baseOperation);

      expect(result.evaluation).toMatchObject({
        walletOperationId: "wop_1",
        decision: "allow",
        reasonCode: "implicit_default_allow",
      });
      expect(result.operation).toMatchObject({
        id: "wop_1",
        status: "evaluated",
      });
      expect(repository.createWalletOperation).toHaveBeenCalledWith(
        expect.objectContaining({ status: "created" })
      );
      expect(repository.updateWalletOperationStatus).toHaveBeenCalledWith("wop_1", "evaluated");
    });

    it("does not reuse terminal approval requests for a new pending decision", async () => {
      const repository = createRepository({
        walletPolicy: walletProfile([
          { id: "large-payment-approval", kind: "approval", families: ["payment"] },
        ]),
        existingApprovalRequestStatus: "failed",
      });
      const service = new WalletPolicyEnforcementService(repository);

      await expect(service.enforce(baseOperation)).rejects.toThrow(
        "Wallet operation approval request is no longer pending"
      );

      expect(repository.createPolicyEvaluation).not.toHaveBeenCalled();
      expect(repository.updateApprovalRequestStatus).not.toHaveBeenCalled();
      expect(repository.updateWalletOperationStatus).not.toHaveBeenCalled();
    });
  });

  describe("enforceWalletOperationPolicy (transactional)", () => {
    const SCOPE = createTenantScope({ organizationId: TEST_ORG.id, projectId: TEST_PROJECT.id });
    const baseWalletOperation: CreateWalletOperationInput = {
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT.id,
      custodyWalletId: TEST_CUSTODY_WALLET.id,
      walletId: TEST_CUSTODY_WALLET.walletId,
      apiKeyId: TEST_API_KEY.id,
      actor: { type: "api_key", id: TEST_API_KEY.id, apiKeyId: TEST_API_KEY.id },
      operationFamily: "payment",
      operationType: "payment_transfer",
      asset: "USDC",
      amount: "25.00",
      destination: "recipient_1",
      rawPayload: { requestId: "req_1" },
    };

    let repo: PolicyRepository;

    beforeAll(async () => {
      await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
    });

    afterAll(async () => {
      await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
    });

    beforeEach(async () => {
      await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
      await seedEnforcementFixtures();
      repo = createPostgresPolicyRepository(getDb(env), SCOPE);
    });

    it("throws a deterministic forbidden response for denied operations", async () => {
      await activateWalletControlPolicy(repo, [
        { id: "destinations", kind: "destination", allowlist: ["recipient_allowed"] },
      ]);

      const error = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "FORBIDDEN"
      );
      expect(error.details).toMatchObject({
        decision: "deny",
        reasonCode: "wallet_policy_match",
      });

      const walletOperationId = requireStringDetail(error, "walletOperationId");
      await expect(repo.getWalletOperationById(walletOperationId)).resolves.toMatchObject({
        id: walletOperationId,
        status: "failed",
      });

      const evaluations = await repo.listPolicyEvaluationsForOperation(walletOperationId);
      expect(evaluations).toHaveLength(1);
      expect(evaluations[0]).toMatchObject({
        decision: "deny",
        reason_code: "wallet_policy_match",
      });
    });

    it("pauses approval-required operations before provider execution", async () => {
      await activateWalletControlPolicy(repo, [
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]);

      const error = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "SIGNING_PENDING"
      );
      expect(error.details).toMatchObject({
        decision: "approval_required",
        requiresApproval: true,
      });

      const walletOperationId = requireStringDetail(error, "walletOperationId");
      const approvalRequestId = requireStringDetail(error, "approvalRequestId");

      await expect(repo.getWalletOperationById(walletOperationId)).resolves.toMatchObject({
        status: "pending_approval",
      });
      await expect(
        repo.getApprovalRequestDetail({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          approvalRequestId,
        })
      ).resolves.toMatchObject({
        wallet_operation_id: walletOperationId,
        approval_status: "pending",
      });
    });

    it("creates approval requests for manual review decisions", async () => {
      await activateWalletControlPolicy(repo, [], "review");

      const error = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "SIGNING_PENDING"
      );
      expect(error.details).toMatchObject({ decision: "review", requiresApproval: false });

      const walletOperationId = requireStringDetail(error, "walletOperationId");
      const approvalRequestId = requireStringDetail(error, "approvalRequestId");

      await expect(repo.getWalletOperationById(walletOperationId)).resolves.toMatchObject({
        status: "pending_approval",
      });
      await expect(
        repo.getApprovalRequestDetail({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          approvalRequestId,
        })
      ).resolves.toMatchObject({ approval_status: "pending" });
    });

    it("stores provider-native approval metadata when present", async () => {
      await getDb(env)
        .prepare(
          `INSERT INTO approval_groups (id, organization_id, project_id, name)
           VALUES ('apg_1', ?, ?, 'Provider approvers')`
        )
        .bind(TEST_ORG.id, TEST_PROJECT.id)
        .run();
      await activateWalletControlPolicy(repo, [
        {
          id: "provider-approval",
          kind: "approval",
          families: ["payment"],
          action: "provider_approval_required",
          approvalGroupId: "apg_1",
        },
      ]);

      const error = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, {
          ...baseWalletOperation,
          providerExtensions: {
            provider: "fireblocks",
            providerReference: "fb_tx_1",
            approvalWindow: "24h",
          },
        }),
        "SIGNING_PENDING"
      );
      expect(error.details).toMatchObject({ decision: "provider_approval_required" });

      const approvalRequestId = requireStringDetail(error, "approvalRequestId");
      await expect(
        repo.getApprovalRequestDetail({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT.id,
          approvalRequestId,
        })
      ).resolves.toMatchObject({
        approval_group_id: "apg_1",
        provider: "fireblocks",
        provider_reference: "fb_tx_1",
      });
    });

    it("lets an API key policy narrow an otherwise allowed wallet operation", async () => {
      await activateWalletControlPolicy(repo, [], "allow");
      await activateApiKeyControlPolicy(repo, [
        { id: "api-key-destination", kind: "destination", blocklist: ["recipient_1"] },
      ]);

      const error = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "FORBIDDEN"
      );
      expect(error.details).toMatchObject({ decision: "deny", reasonCode: "api_key_policy_match" });

      const walletOperationId = requireStringDetail(error, "walletOperationId");
      await expect(repo.getWalletOperationById(walletOperationId)).resolves.toMatchObject({
        status: "failed",
      });
    });

    it("approves, rejects, and cancels approval requests idempotently", async () => {
      await activateWalletControlPolicy(repo, [
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]);
      const service = new WalletPolicyEnforcementService(repo);

      const approveError = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "SIGNING_PENDING"
      );
      const approveRequestId = requireStringDetail(approveError, "approvalRequestId");

      await expect(
        service.approveApprovalRequest(
          TEST_ORG.id,
          approveRequestId,
          "usr_approver",
          TEST_PROJECT.id
        )
      ).resolves.toMatchObject({ status: "approved", resolved_by: "usr_approver" });
      await expect(
        service.approveApprovalRequest(
          TEST_ORG.id,
          approveRequestId,
          "usr_approver",
          TEST_PROJECT.id
        )
      ).resolves.toMatchObject({ status: "approved", resolved_by: "usr_approver" });

      const cancelError = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "SIGNING_PENDING"
      );
      const cancelRequestId = requireStringDetail(cancelError, "approvalRequestId");

      await expect(
        service.cancelApprovalRequest(TEST_ORG.id, cancelRequestId, "usr_approver", TEST_PROJECT.id)
      ).resolves.toMatchObject({ status: "canceled", resolved_by: "usr_approver" });
      await expect(
        service.cancelApprovalRequest(TEST_ORG.id, cancelRequestId, "usr_approver", TEST_PROJECT.id)
      ).resolves.toMatchObject({ status: "canceled", resolved_by: "usr_approver" });

      const rejectError = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "SIGNING_PENDING"
      );
      const rejectRequestId = requireStringDetail(rejectError, "approvalRequestId");

      await expect(
        service.rejectApprovalRequest(TEST_ORG.id, rejectRequestId, "usr_approver", TEST_PROJECT.id)
      ).resolves.toMatchObject({ status: "rejected", resolved_by: "usr_approver" });
      await expect(
        service.rejectApprovalRequest(TEST_ORG.id, rejectRequestId, "usr_approver", TEST_PROJECT.id)
      ).resolves.toMatchObject({ status: "rejected", resolved_by: "usr_approver" });
    });

    it("rejects conflicting approval request terminal transitions", async () => {
      await activateWalletControlPolicy(repo, [
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]);
      const service = new WalletPolicyEnforcementService(repo);

      const firstError = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "SIGNING_PENDING"
      );
      const firstRequestId = requireStringDetail(firstError, "approvalRequestId");
      await service.cancelApprovalRequest(
        TEST_ORG.id,
        firstRequestId,
        "usr_approver",
        TEST_PROJECT.id
      );

      await expect(
        service.approveApprovalRequest(TEST_ORG.id, firstRequestId, "usr_approver", TEST_PROJECT.id)
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Approval request is already canceled",
      });

      const secondError = await expectPolicyDecisionError(
        enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation),
        "SIGNING_PENDING"
      );
      const secondRequestId = requireStringDetail(secondError, "approvalRequestId");
      await service.approveApprovalRequest(
        TEST_ORG.id,
        secondRequestId,
        "usr_approver",
        TEST_PROJECT.id
      );

      await expect(
        service.cancelApprovalRequest(TEST_ORG.id, secondRequestId, "usr_approver", TEST_PROJECT.id)
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "Approval request is already approved",
      });
    });

    it("rolls back the wallet operation when policy evaluation resolution throws", async () => {
      const before = await countWalletOperations();
      const spy = vi
        .spyOn(PolicyFoundationService.prototype, "evaluateWalletOperationPolicies")
        .mockRejectedValue(new Error("policy resolver unavailable"));

      try {
        await expect(enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation)).rejects.toThrow(
          "policy resolver unavailable"
        );
      } finally {
        spy.mockRestore();
      }

      expect(await countWalletOperations()).toBe(before);
      expect(await countApprovalRequests()).toBe(0);
    });

    it("fails approval requests and wallet operations together when recording the evaluation fails", async () => {
      await activateWalletControlPolicy(repo, [
        { id: "large-payment-approval", kind: "approval", families: ["payment"] },
      ]);

      const before = await countWalletOperations();
      const spy = vi
        .spyOn(PolicyFoundationService.prototype, "recordPolicyEvaluation")
        .mockRejectedValue(new Error("evaluation write unavailable"));

      try {
        await expect(enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation)).rejects.toThrow(
          "evaluation write unavailable"
        );
      } finally {
        spy.mockRestore();
      }

      expect(await countWalletOperations()).toBe(before);
      expect(await countApprovalRequests()).toBe(0);
    });

    it("rolls back before any row persists when recording the wallet operation fails", async () => {
      const before = await countWalletOperations();
      const spy = vi
        .spyOn(PolicyFoundationService.prototype, "recordWalletOperation")
        .mockRejectedValue(new Error("wallet operation write unavailable"));

      try {
        await expect(enforceWalletOperationPolicy(env, SCOPE, baseWalletOperation)).rejects.toThrow(
          "wallet operation write unavailable"
        );
      } finally {
        spy.mockRestore();
      }

      expect(await countWalletOperations()).toBe(before);
      expect(await countApprovalRequests()).toBe(0);
    });
  });
});

/**
 * Activates a wallet control profile revision for the shared enforcement test
 * fixtures so `enforceWalletOperationPolicy` resolves it as the active policy.
 *
 * @param repo - The scoped policy repository to write through.
 * @param rules - The revision's rules.
 * @param defaultAction - The revision's default action when no rule matches.
 */
async function activateWalletControlPolicy(
  repo: PolicyRepository,
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): Promise<void> {
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: TEST_CUSTODY_WALLET.id,
    name: "Enforcement wallet controls",
    createdBy: TEST_USER.id,
  });
  if (!profile) {
    throw new Error("Expected wallet control profile to be created");
  }

  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    rules,
    defaultAction,
    createdBy: TEST_USER.id,
  });
  if (!revision) {
    throw new Error("Expected wallet control profile revision to be created");
  }

  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

/**
 * Activates an API key control profile revision for the shared enforcement
 * test fixtures so `enforceWalletOperationPolicy` resolves it as the active
 * policy for the fixture API key.
 *
 * @param repo - The scoped policy repository to write through.
 * @param rules - The revision's rules.
 * @param defaultAction - The revision's default action when no rule matches.
 */
async function activateApiKeyControlPolicy(
  repo: PolicyRepository,
  rules: PolicyRule[],
  defaultAction: PolicyDefaultAction = "allow"
): Promise<void> {
  const profile = await repo.createApiKeyControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    apiKeyId: TEST_API_KEY.id,
    name: "Enforcement API key controls",
    createdBy: TEST_USER.id,
  });
  if (!profile) {
    throw new Error("Expected API key control profile to be created");
  }

  const revision = await repo.createApiKeyControlProfileRevision({
    profileId: profile.id,
    rules,
    defaultAction,
    createdBy: TEST_USER.id,
  });
  if (!revision) {
    throw new Error("Expected API key control profile revision to be created");
  }

  await repo.activateApiKeyControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

/**
 * Counts wallet_operations rows, for asserting a rolled-back transaction left
 * no candidate row behind.
 *
 * @returns The current row count.
 */
async function countWalletOperations(): Promise<number> {
  const result = await getDb(env)
    .prepare("SELECT COUNT(*) as count FROM wallet_operations")
    .first<{ count: number }>();
  if (!result) {
    throw new Error("Expected a count row from wallet_operations");
  }
  return result.count;
}

/**
 * Counts approval_requests rows, for asserting a rolled-back transaction left
 * no approval request behind.
 *
 * @returns The current row count.
 */
async function countApprovalRequests(): Promise<number> {
  const result = await getDb(env)
    .prepare("SELECT COUNT(*) as count FROM approval_requests")
    .first<{ count: number }>();
  if (!result) {
    throw new Error("Expected a count row from approval_requests");
  }
  return result.count;
}

/**
 * Seeds the organization, user, project, API key, and custody wallet the
 * transactional enforcement tests depend on.
 */
async function seedEnforcementFixtures(): Promise<void> {
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
       ) VALUES (?, ?, ?, ?, 'Test key', ?, 'hash_policy_enforcement', 'api_admin', '["*"]', 'active')`
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
