import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_CUSTODY_CONFIG, TEST_CUSTODY_WALLET } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedRecurringDatabaseTenant } from "@/test/helpers/recurring-payments";
import { seedTestDatabase } from "@/test/mocks/db";
import {
  assertNoPendingRecurringCollectionApproval,
  enforceRecurringPaymentPolicy,
} from "./policy";

const TEST_SCOPE = createTenantScope({
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
});

const FIRST_DUE_AT = "2026-07-01T12:00:00.000Z";
const SECOND_DUE_AT = "2026-07-02T12:00:00.000Z";

async function seedPolicyFixtures(): Promise<void> {
  await seedRecurringDatabaseTenant({
    organizationId: TEST_ORG.id,
    organizationName: TEST_ORG.name,
    organizationSlug: TEST_ORG.slug,
    userId: TEST_USER.id,
    userEmail: TEST_USER.email,
    projectId: TEST_PROJECT.id,
    custodyConfigId: TEST_CUSTODY_CONFIG.id,
    custodyWalletId: TEST_CUSTODY_WALLET.id,
    providerWalletId: TEST_CUSTODY_WALLET.walletId,
    publicKey: TEST_CUSTODY_WALLET.publicKey,
  });
}

async function seedApprovalRequiredWalletPolicy(): Promise<void> {
  const repo = createPostgresPolicyRepository(getDb(env), TEST_SCOPE);
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: TEST_CUSTODY_WALLET.id,
    name: "Collection approval controls",
  });
  expect(profile).not.toBeNull();
  if (profile === null) throw new Error("Failed to create wallet control profile");
  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile.id,
    defaultAction: "approval_required",
  });
  expect(revision).not.toBeNull();
  if (revision === null) throw new Error("Failed to create wallet control profile revision");
  await repo.activateWalletControlProfileRevision({
    profileId: profile.id,
    revisionId: revision.id,
  });
}

function collectionPolicyInput(collectionDueAt: string) {
  return {
    env,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    sourceWallet: TEST_CUSTODY_WALLET,
    token: "TokenMint1111111111111111111111111111111111",
    amount: "10",
    destination: "Destination11111111111111111111111111111111",
    apiKeyId: null,
    actor: null,
    rawPayload: {
      operationType: "recurring_payment_collection" as const,
      recurringPaymentId: "prp_collection_policy",
      subscriptionId: "sub_collection_policy",
      collectionDueAt,
    },
  };
}

async function expectSigningPending(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    expect(error.code).toBe("SIGNING_PENDING");
    return error;
  }
  throw new Error("Expected the collection to pause for policy approval");
}

async function pendingRows() {
  const approvals = await getDb(env)
    .prepare(
      `SELECT id, wallet_operation_id
         FROM approval_requests
        WHERE status = 'pending'
        ORDER BY created_at ASC, id ASC`
    )
    .all<{ id: string; wallet_operation_id: string }>();
  const operations = await getDb(env)
    .prepare("SELECT id, status FROM wallet_operations ORDER BY created_at ASC, id ASC")
    .all<{ id: string; status: string }>();
  return { approvals: approvals.results, operations: operations.results };
}

describe("enforceRecurringPaymentPolicy (collection approvals)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await seedTestDatabase(env);
  });

  beforeEach(async () => {
    await seedTestDatabase(env);
    await seedPolicyFixtures();
    await seedApprovalRequiredWalletPolicy();
  });

  it("reuses the pending approval when a due cycle's collection is retried", async () => {
    const first = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );
    const retry = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );

    expect(first.details).not.toBeNull();
    expect(retry.details).not.toBeNull();
    if (first.details == null || retry.details == null) throw new Error("Missing error details");
    expect(first.details.approvalRequestId).toEqual(expect.any(String));
    expect(retry.details.approvalRequestId).toBe(first.details.approvalRequestId);
    expect(retry.details.walletOperationId).toBe(first.details.walletOperationId);

    const { approvals, operations } = await pendingRows();
    expect(approvals).toHaveLength(1);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "pending_approval" });
  });

  it("blocks a source change while a legacy collection approval is pending", async () => {
    const pending = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );
    expect(pending.details).not.toBeNull();
    if (pending.details == null) throw new Error("Missing error details");
    const operationId = pending.details.walletOperationId;

    await getDb(env)
      .prepare("UPDATE wallet_operations SET custody_wallet_id = NULL WHERE id = ?")
      .bind(operationId)
      .run();

    await expect(
      assertNoPendingRecurringCollectionApproval({
        db: getDb(env),
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT.id,
        custodyWalletId: TEST_CUSTODY_WALLET.id,
        recurringPaymentId: "prp_collection_policy",
        collectionDueAt: FIRST_DUE_AT,
      })
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      message: "Recurring payment source cannot change while a collection approval is pending",
      details: {
        walletOperationId: operationId,
        policyEvaluationId: pending.details.policyEvaluationId,
        approvalRequestId: pending.details.approvalRequestId,
      },
    });
  });

  it("does not file a second approval once the cycle's approval is granted", async () => {
    const first = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );
    expect(first.details).not.toBeNull();
    if (first.details == null) throw new Error("Missing error details");
    const operationId = first.details.walletOperationId;
    const approvalId = first.details.approvalRequestId;
    await getDb(env)
      .prepare("UPDATE approval_requests SET status = 'approved' WHERE id = ?")
      .bind(approvalId)
      .run();
    await getDb(env)
      .prepare("UPDATE wallet_operations SET status = 'executing' WHERE id = ?")
      .bind(operationId)
      .run();

    const retry = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );

    expect(retry.details).not.toBeNull();
    if (retry.details == null) throw new Error("Missing error details");
    expect(retry.details.approvalRequestId).toBe(approvalId);
    expect(retry.details.walletOperationId).toBe(operationId);

    const allApprovals = await getDb(env)
      .prepare("SELECT id FROM approval_requests")
      .all<{ id: string }>();
    expect(allApprovals.results).toHaveLength(1);
  });

  it("fails closed when an approved legacy collection has no exact wallet identity", async () => {
    const first = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );
    expect(first.details).not.toBeNull();
    if (first.details == null) throw new Error("Missing error details");
    const operationId = first.details.walletOperationId;
    const approvalId = first.details.approvalRequestId;

    await getDb(env).batch([
      getDb(env)
        .prepare("UPDATE approval_requests SET status = 'approved' WHERE id = ?")
        .bind(approvalId),
      getDb(env)
        .prepare(
          "UPDATE wallet_operations SET status = 'executing', custody_wallet_id = NULL WHERE id = ?"
        )
        .bind(operationId),
    ]);

    await expect(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    ).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
      message: "Recurring payment collection approval wallet identity is unresolved",
      details: {
        walletOperationId: operationId,
        policyEvaluationId: first.details.policyEvaluationId,
        approvalRequestId: approvalId,
      },
    });

    expect(
      await getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM wallet_operations")
        .first<{ count: number }>()
    ).toEqual({ count: 1 });
    expect(
      await getDb(env)
        .prepare("SELECT COUNT(*)::int AS count FROM approval_requests")
        .first<{ count: number }>()
    ).toEqual({ count: 1 });
  });

  it("still files a new approval for a new due cycle", async () => {
    const first = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );
    const nextCycle = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(SECOND_DUE_AT))
    );

    expect(first.details).not.toBeNull();
    expect(nextCycle.details).not.toBeNull();
    if (first.details == null || nextCycle.details == null)
      throw new Error("Missing error details");
    expect(nextCycle.details.approvalRequestId).not.toBe(first.details.approvalRequestId);

    const { approvals } = await pendingRows();
    expect(approvals).toHaveLength(2);
  });
});
