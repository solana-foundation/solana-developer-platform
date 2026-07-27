import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createAssetWorkflowsRepository,
  createKycWalletsRepository,
  createWalletAssetEnrollmentsRepository,
  createWorkflowExecutionsRepository,
} from "@/db/repositories";
import { runDueWorkflowExecutions } from "@/services/jobs/run-workflow-executions";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { clearTestDatabase, seedTestDatabase } from "@/test/mocks/db";
import { emitKycApprovedForClearedEnrollments } from "./clearance";

const TEST_PROJECT_ID = "prj_workflow_engine_test";
const TEST_TOKEN_ID = "tok_workflow_engine_test";

// Uses the `record` action so the canonical enqueue→claim→run→complete engine path is
// exercised end-to-end with no on-chain dependency.
describe("workflow engine (postgres)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  afterAll(async () => {
    await clearTestDatabase(env as Parameters<typeof clearTestDatabase>[0]);
  });

  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM workflow_executions").run();
    await db.prepare("DELETE FROM asset_workflows").run();
    await db.prepare("DELETE FROM wallet_asset_enrollments").run();
    await db.prepare("DELETE FROM kyc_wallets").run();
    await db.prepare("DELETE FROM issued_tokens").run();
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
    await db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Test Project', 'test-project', 'sandbox', 'active', ?)`
      )
      .bind(TEST_PROJECT_ID, TEST_ORG.id, TEST_USER.id)
      .run();
    await db
      .prepare(
        `INSERT INTO issued_tokens (id, organization_id, project_id, name, symbol, created_by)
         VALUES (?, ?, ?, 'Engine Test Token', 'ENG', ?)`
      )
      .bind(TEST_TOKEN_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();
  });

  async function seedRule() {
    return createAssetWorkflowsRepository(env).createWorkflow({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      triggerType: "kyc_approved",
      actionType: "record",
      definition: {
        condition: null,
        action: { type: "record", params: {} },
        retryPolicy: { maxAttempts: 5, retryAfterMinutes: 5 },
      },
      version: 1,
      reviewMode: "auto",
      createdBy: TEST_USER.id,
    });
  }

  async function seedVerifiedEnrolledWallet() {
    const kycRepo = createKycWalletsRepository(env);
    const wallet = await kycRepo.upsertKycWallet({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAddress: "So11111111111111111111111111111111111111112",
      createdBy: TEST_USER.id,
    });
    if (!wallet) {
      throw new Error("failed to seed kyc wallet");
    }
    await createWalletAssetEnrollmentsRepository(env).upsertEnrollment({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      kycWalletId: wallet.id,
      tokenId: TEST_TOKEN_ID,
      createdBy: TEST_USER.id,
    });
    const verified = await kycRepo.setKycStatus({
      kycWalletId: wallet.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      status: "verified",
      provider: "mural",
    });
    if (!verified) {
      throw new Error("failed to verify kyc wallet");
    }
    return verified;
  }

  it("enqueues one execution when a cleared wallet's KYC is approved", async () => {
    await seedRule();
    const wallet = await seedVerifiedEnrolledWallet();

    const dispatched = await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });
    expect(dispatched).toBe(1);

    const { rows } = await createWorkflowExecutionsRepository(env).listExecutions({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      limit: 10,
      offset: 0,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("pending");
    expect(rows[0].action_type).toBe("record");
  });

  it("does not double-enqueue on a re-delivered event (idempotency)", async () => {
    await seedRule();
    const wallet = await seedVerifiedEnrolledWallet();

    await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });
    const second = await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });
    expect(second).toBe(0);

    const { total } = await createWorkflowExecutionsRepository(env).listExecutions({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      limit: 10,
      offset: 0,
    });
    expect(total).toBe(1);
  });

  it("runs the due execution to succeeded", async () => {
    await seedRule();
    const wallet = await seedVerifiedEnrolledWallet();
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });

    const result = await runDueWorkflowExecutions(env);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(0);

    const { rows } = await createWorkflowExecutionsRepository(env).listExecutions({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      limit: 10,
      offset: 0,
    });
    expect(rows[0].status).toBe("succeeded");
    expect(rows[0].result).toMatchObject({ recorded: true });
    expect(rows[0].attempt_count).toBe(1);
  });

  it("does not enqueue when the wallet is enrolled but not yet verified", async () => {
    await seedRule();
    const wallet = await createKycWalletsRepository(env).upsertKycWallet({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAddress: "So11111111111111111111111111111111111111113",
      createdBy: TEST_USER.id,
    });
    if (!wallet) {
      throw new Error("failed to seed wallet");
    }
    await createWalletAssetEnrollmentsRepository(env).upsertEnrollment({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      kycWalletId: wallet.id,
      tokenId: TEST_TOKEN_ID,
      createdBy: TEST_USER.id,
    });

    // Wallet is 'unverified' — clearance must not fire.
    const dispatched = await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });
    expect(dispatched).toBe(0);
  });
});
