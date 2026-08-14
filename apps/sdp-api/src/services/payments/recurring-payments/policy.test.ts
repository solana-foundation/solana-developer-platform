import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { createPostgresPolicyRepository } from "@/db/repositories";
import { AppError } from "@/lib/errors";
import { createTenantScope } from "@/lib/tenant-scope";
import { TEST_CUSTODY_CONFIG, TEST_CUSTODY_WALLET } from "@/test/fixtures/custody";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { TEST_PROJECT } from "@/test/fixtures/tokens";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { enforceRecurringPaymentPolicy } from "./policy";

const TEST_SCOPE = createTenantScope({
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
});

const FIRST_DUE_AT = "2026-07-01T12:00:00.000Z";
const SECOND_DUE_AT = "2026-07-02T12:00:00.000Z";

async function seedPolicyFixtures(): Promise<void> {
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

  // The config's default_wallet_id FK is deferred, so the config and its
  // default wallet must land in one transaction.
  await db.batch([
    db
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
      .bind(TEST_CUSTODY_CONFIG.id, TEST_ORG.id, TEST_PROJECT.id, TEST_CUSTODY_WALLET.walletId),
    db
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
      ),
  ]);
}

async function seedApprovalRequiredWalletPolicy(): Promise<void> {
  const repo = createPostgresPolicyRepository(getDb(env), TEST_SCOPE);
  const profile = await repo.createWalletControlProfile({
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    custodyWalletId: TEST_CUSTODY_WALLET.id,
    name: "Collection approval controls",
  });
  const revision = await repo.createWalletControlProfileRevision({
    profileId: profile?.id ?? "",
    defaultAction: "approval_required",
  });
  await repo.activateWalletControlProfileRevision({
    profileId: profile?.id ?? "",
    revisionId: revision?.id ?? "",
  });
}

function collectionPolicyInput(collectionDueAt: string) {
  return {
    env,
    organizationId: TEST_ORG.id,
    projectId: TEST_PROJECT.id,
    sourceWallet: TEST_CUSTODY_WALLET,
    operationType: "recurring_payment_collection" as const,
    token: "TokenMint1111111111111111111111111111111111",
    amount: "10",
    destination: "Destination11111111111111111111111111111111",
    apiKeyId: null,
    actor: null,
    rawPayload: {
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
    expect(error).toBeInstanceOf(AppError);
    const appError = error as AppError;
    expect(appError.code).toBe("SIGNING_PENDING");
    return appError;
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
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  beforeEach(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
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

    expect(first.details?.approvalRequestId).toEqual(expect.any(String));
    expect(retry.details?.approvalRequestId).toBe(first.details?.approvalRequestId);
    expect(retry.details?.walletOperationId).toBe(first.details?.walletOperationId);

    const { approvals, operations } = await pendingRows();
    expect(approvals).toHaveLength(1);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "pending_approval" });
  });

  it("does not file a second approval once the cycle's approval is granted", async () => {
    const first = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );
    const operationId = first.details?.walletOperationId as string;
    const approvalId = first.details?.approvalRequestId as string;

    // What granting an approval leaves behind: the request is approved and
    // the operation moves to executing while it waits to run.
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

    expect(retry.details?.approvalRequestId).toBe(approvalId);
    expect(retry.details?.walletOperationId).toBe(operationId);

    const allApprovals = await getDb(env)
      .prepare("SELECT id FROM approval_requests")
      .all<{ id: string }>();
    expect(allApprovals.results).toHaveLength(1);
  });

  it("still files a new approval for a new due cycle", async () => {
    const first = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(FIRST_DUE_AT))
    );
    const nextCycle = await expectSigningPending(
      enforceRecurringPaymentPolicy(collectionPolicyInput(SECOND_DUE_AT))
    );

    expect(nextCycle.details?.approvalRequestId).not.toBe(first.details?.approvalRequestId);

    const { approvals } = await pendingRows();
    expect(approvals).toHaveLength(2);
  });
});
