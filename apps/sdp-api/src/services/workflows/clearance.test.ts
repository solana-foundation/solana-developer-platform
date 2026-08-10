import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import {
  createAssetWorkflowsRepository,
  createKycWalletsRepository,
  createWalletAssetEnrollmentsRepository,
} from "@/db/repositories";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";
import { emitKycApprovedForClearedEnrollments, emitKycRejectedForEnrollments } from "./clearance";

const TEST_PROJECT_ID = "prj_clearance_test";
const TEST_TOKEN_ID = "tok_clearance_test";
const WALLET_ADDRESS = "So11111111111111111111111111111111111111112";

// sdp_iso_now() is millisecond-resolution, so two writes inside the same millisecond
// would collide and hide the bug. Space them out to keep the test deterministic.
const nextMillisecond = () => new Promise((resolve) => setTimeout(resolve, 5));

// A redelivered provider webhook re-runs the same status write. Every write re-stamps
// updated_at (and verified_at when the status is 'verified'), so a key derived from
// those timestamps changes between deliveries — which slips past the
// (workflow_id, idempotency_key) unique constraint and enqueues the rule twice.
describe("KYC clearance idempotency across redelivered webhooks (postgres)", () => {
  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
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
         VALUES (?, ?, ?, 'Clearance Test Token', 'CLR', ?)`
      )
      .bind(TEST_TOKEN_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();
  });

  async function seedRule(triggerType: "kyc_approved" | "kyc_rejected") {
    return createAssetWorkflowsRepository(env).createWorkflow({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      triggerType,
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

  async function seedEnrolledWallet() {
    const wallet = await createKycWalletsRepository(env).upsertKycWallet({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAddress: WALLET_ADDRESS,
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
    return wallet;
  }

  // Re-runs the provider's status write exactly as a redelivery would, returning the
  // freshly-read row the emitter is handed.
  async function applyStatus(kycWalletId: string, status: "verified" | "rejected") {
    const row = await createKycWalletsRepository(env).setKycStatus({
      kycWalletId,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      status,
      provider: "mural",
      providerRef: "mural_ref_1",
    });
    if (!row) {
      throw new Error("failed to set kyc status");
    }
    return row;
  }

  async function executionCount() {
    const row = await getDb(env)
      .prepare("SELECT COUNT(*)::int AS n FROM workflow_executions")
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  it("enqueues one execution when a kyc_rejected webhook is redelivered", async () => {
    await seedRule("kyc_rejected");
    const wallet = await seedEnrolledWallet();

    const first = await applyStatus(wallet.id, "rejected");
    await emitKycRejectedForEnrollments(env, { kycWallet: first, provider: "mural" });

    await nextMillisecond();

    // Redelivery: same logical rejection, but the row is written again.
    const redelivered = await applyStatus(wallet.id, "rejected");
    await emitKycRejectedForEnrollments(env, { kycWallet: redelivered, provider: "mural" });

    expect(await executionCount()).toBe(1);
  });

  // A rejection's key falls back to updated_at, so any write that touches the row between
  // the first delivery and a retry re-dates the same rejection into a fresh key. Enrolling
  // the holder for a second asset does exactly that: the status write is already guarded,
  // but the enrollment upsert re-stamped updated_at on its own.
  it("enqueues one execution when an unrelated write lands between redeliveries", async () => {
    await seedRule("kyc_rejected");
    const wallet = await seedEnrolledWallet();

    const first = await applyStatus(wallet.id, "rejected");
    await emitKycRejectedForEnrollments(env, { kycWallet: first, provider: "mural" });

    await nextMillisecond();

    // The holder is enrolled for another asset — same wallet row, re-upserted.
    await createKycWalletsRepository(env).upsertKycWallet({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      walletAddress: WALLET_ADDRESS,
      createdBy: TEST_USER.id,
    });

    await nextMillisecond();

    const redelivered = await applyStatus(wallet.id, "rejected");
    await emitKycRejectedForEnrollments(env, { kycWallet: redelivered, provider: "mural" });

    expect(await executionCount()).toBe(1);
  });

  // Same root cause on the approved path: verified_at is re-stamped by every write with
  // status='verified', so the flagship kyc_approved → allowlist_add rule double-fired too.
  it("enqueues one execution when a kyc_approved webhook is redelivered", async () => {
    await seedRule("kyc_approved");
    const wallet = await seedEnrolledWallet();

    const first = await applyStatus(wallet.id, "verified");
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: first, provider: "mural" });

    await nextMillisecond();

    const redelivered = await applyStatus(wallet.id, "verified");
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: redelivered, provider: "mural" });

    expect(await executionCount()).toBe(1);
  });

  // Guards the behaviour the transition key exists for: a holder who is rejected and then
  // re-verified must be re-allowlisted, so a genuine new transition still fires.
  it("still fires again after a real verified → rejected → verified cycle", async () => {
    await seedRule("kyc_approved");
    const wallet = await seedEnrolledWallet();

    const verified = await applyStatus(wallet.id, "verified");
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: verified, provider: "mural" });

    await nextMillisecond();
    await applyStatus(wallet.id, "rejected");
    await nextMillisecond();

    const reVerified = await applyStatus(wallet.id, "verified");
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: reVerified, provider: "mural" });

    expect(await executionCount()).toBe(2);
  });
});
