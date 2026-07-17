import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { isPostgresUniqueViolation } from "@/db/postgres-utils";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import type { PaymentTransferBatchesRepository } from "./payment-transfer-batches.repository";
import { createPostgresPaymentTransferBatchesRepository } from "./payment-transfer-batches.repository.postgres";

const TEST_PROJECT_ID = "prj_transfer_batches_repo_test";
const OTHER_PROJECT_ID = "prj_transfer_batches_repo_test_other";
const TEST_WALLET_ID = "wallet_transfer_batches_repo_test";

describe("PaymentTransferBatchesRepository idempotency (postgres)", () => {
  let repo: PaymentTransferBatchesRepository;

  beforeAll(async () => {
    await seedTestDatabase(env);
  });

  afterAll(async () => {
    await clearTestDatabase(env);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM payment_transfer_batches").run();
    await db.prepare("DELETE FROM projects").run();

    await db
      .prepare(
        "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, ?, ?, 'individual', 'active')"
      )
      .bind(TEST_ORG.id, TEST_ORG.name, TEST_ORG.slug)
      .run();
    await db
      .prepare(
        "INSERT OR REPLACE INTO users (id, email, email_verified, status) VALUES (?, ?, 1, 'active')"
      )
      .bind(TEST_USER.id, TEST_USER.email)
      .run();
    for (const projectId of [TEST_PROJECT_ID, OTHER_PROJECT_ID]) {
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Test Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(projectId, TEST_ORG.id, projectId, TEST_USER.id)
        .run();
    }

    repo = createPostgresPaymentTransferBatchesRepository(db);
  });

  const baseInput = {
    organizationId: TEST_ORG.id,
    sourceWalletId: TEST_WALLET_ID,
    sourceAddress: "Source111",
    token: "SOL",
    status: "processing" as const,
    totalAmount: "1",
    recipientCount: 1,
    transactionCount: 1,
    options: {},
    initiatedByKeyId: null,
    idempotencyFingerprint: "fp-1",
  };

  it("persists idempotency metadata and finds a batch by organization, project, and key", async () => {
    const { batch: created } = await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "batch-key-abc" },
      recipients: [],
    });

    expect(created.idempotency_key).toBe("batch-key-abc");

    const found = await repo.findTransferBatchByIdempotency({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      idempotencyKey: "batch-key-abc",
    });
    expect(found).toMatchObject({
      id: created.id,
      idempotency_fingerprint: "fp-1",
    });
  });

  it("scopes idempotency keys to the project", async () => {
    const { batch: first } = await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "shared-batch-key" },
      recipients: [],
    });
    const { batch: second } = await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: OTHER_PROJECT_ID, idempotencyKey: "shared-batch-key" },
      recipients: [],
    });

    expect(first.id).not.toBe(second.id);
    expect(
      await repo.findTransferBatchByIdempotency({
        organizationId: TEST_ORG.id,
        projectId: OTHER_PROJECT_ID,
        idempotencyKey: "shared-batch-key",
      })
    ).toMatchObject({ id: second.id });
  });

  it("rejects a second batch with the same organization, project, and idempotency key", async () => {
    await repo.createTransferBatchWithRecipients({
      batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "duplicate-batch-key" },
      recipients: [],
    });

    await expect(
      repo.createTransferBatchWithRecipients({
        batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "duplicate-batch-key" },
        recipients: [],
      })
    ).rejects.toSatisfy((error: unknown) => isPostgresUniqueViolation(error));
  });

  it("rolls back the batch row when a recipient insert fails", async () => {
    await expect(
      repo.createTransferBatchWithRecipients({
        batch: { ...baseInput, projectId: TEST_PROJECT_ID, idempotencyKey: "rollback-batch-key" },
        recipients: [
          {
            organizationId: TEST_ORG.id,
            projectId: TEST_PROJECT_ID,
            externalId: null,
            counterpartyId: "cpty_does_not_exist",
            counterpartyAccountId: "cpacct_does_not_exist",
            destinationAddress: "Dest111",
            amount: "1",
            status: "pending",
            error: null,
          },
        ],
      })
    ).rejects.toThrow();

    expect(
      await repo.findTransferBatchByIdempotency({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        idempotencyKey: "rollback-batch-key",
      })
    ).toBeNull();
  });
});
