import { beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { seedTestDatabase } from "@/test/mocks/db";
import { emitKycApprovedForClearedEnrollments } from "./clearance";

const TEST_PROJECT_ID = "prj_workflow_engine_test";
const TEST_TOKEN_ID = "tok_workflow_engine_test";

// Uses the `record` action so the canonical enqueue→claim→run→complete engine path is
// exercised end-to-end with no on-chain dependency.
describe("workflow engine (postgres)", () => {
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
         VALUES (?, ?, ?, 'Engine Test Token', 'ENG', ?)`
      )
      .bind(TEST_TOKEN_ID, TEST_ORG.id, TEST_PROJECT_ID, TEST_USER.id)
      .run();
  });

  async function seedRule(
    actionType: "record" | "allowlist_add" | "mint" = "record",
    params: Record<string, string | number> = {}
  ) {
    return createAssetWorkflowsRepository(env).createWorkflow({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      triggerType: "kyc_approved",
      actionType,
      definition: {
        condition: null,
        action: { type: actionType, params },
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

  it("fails permanently (no retry) when the action's capability is revoked post-save", async () => {
    // allowlist_add requires the asset to have an allowlist; the seeded token has no
    // ablListAddress, simulating a capability turned off after the rule was created
    // (repo-level create bypasses the save-time gate, like a post-save revocation).
    await seedRule("allowlist_add");
    const wallet = await seedVerifiedEnrolledWallet();
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });

    const result = await runDueWorkflowExecutions(env);
    expect(result.failed).toBe(1);
    expect(result.retried).toBe(0);

    const repo = createWorkflowExecutionsRepository(env);
    const { rows } = await repo.listExecutions({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      limit: 10,
      offset: 0,
    });
    expect(rows[0].status).toBe("failed");
    expect(rows[0].error).toMatch(/^CAPABILITY_REVOKED:/);
    expect(rows[0].next_attempt_at).toBeNull();

    // A second tick must not pick the row back up.
    const second = await runDueWorkflowExecutions(env);
    expect(second.succeeded + second.failed + second.retried).toBe(0);
  });

  it("holds a destructive action for review, and a failure after approval is single-shot", async () => {
    // mint is requires_approval tier → enqueues as awaiting_review even with auto review.
    await seedRule("mint", { amount: "10" });
    const wallet = await seedVerifiedEnrolledWallet();
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });

    const repo = createWorkflowExecutionsRepository(env);
    const list = () =>
      repo.listExecutions({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        tokenId: TEST_TOKEN_ID,
        limit: 10,
        offset: 0,
      });

    let { rows } = await list();
    expect(rows[0].status).toBe("awaiting_review");

    // The engine must not touch held executions.
    const held = await runDueWorkflowExecutions(env);
    expect(held.succeeded + held.failed + held.retried).toBe(0);

    // Human approves → pending → the run fails (token has no mint address) and must
    // land in failed after exactly one attempt — never back into the retry loop.
    const approved = await repo.approveExecution({
      executionId: rows[0].id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      decidedBy: TEST_USER.id,
    });
    expect(approved?.status).toBe("pending");
    expect(approved?.decided_by).toBe(TEST_USER.id);

    const run = await runDueWorkflowExecutions(env);
    expect(run.failed).toBe(1);
    expect(run.retried).toBe(0);

    ({ rows } = await list());
    expect(rows[0].status).toBe("failed");
    expect(rows[0].next_attempt_at).toBeNull();
  });

  it("manual retry resets attempt_count so an attempts-exhausted execution re-runs", async () => {
    await seedRule();
    const wallet = await seedVerifiedEnrolledWallet();
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });

    const repo = createWorkflowExecutionsRepository(env);
    const { rows } = await repo.listExecutions({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      limit: 10,
      offset: 0,
    });

    // Simulate an execution that burned through its attempt budget and failed.
    await getDb(env)
      .prepare(
        "UPDATE workflow_executions SET status = 'failed', attempt_count = max_attempts WHERE id = ?"
      )
      .bind(rows[0].id)
      .run();

    const retried = await repo.retryExecution({
      executionId: rows[0].id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      decidedBy: TEST_USER.id,
    });
    expect(retried?.status).toBe("pending");
    expect(retried?.attempt_count).toBe(0);

    // Without the attempt reset the due-poll would skip this row forever.
    const result = await runDueWorkflowExecutions(env);
    expect(result.succeeded).toBe(1);
  });

  it("stale recovery re-queues safe actions but parks approval-gated ones as failed", async () => {
    const recordRule = await seedRule("record");
    const mintRule = await seedRule("mint", { amount: "1" });
    if (!recordRule || !mintRule) {
      throw new Error("failed to seed rules");
    }

    const repo = createWorkflowExecutionsRepository(env);
    const seedExecution = (workflowId: string, actionType: "record" | "mint", key: string) =>
      repo.createExecution({
        organizationId: TEST_ORG.id,
        projectId: TEST_PROJECT_ID,
        workflowId,
        tokenId: TEST_TOKEN_ID,
        triggerType: "kyc_approved",
        actionType,
        status: "pending",
        idempotencyKey: key,
        triggerPayload: {},
        maxAttempts: 5,
      });
    const recordExec = await seedExecution(recordRule.id, "record", "stale:record");
    const mintExec = await seedExecution(mintRule.id, "mint", "stale:mint");
    if (!recordExec || !mintExec) {
      throw new Error("failed to seed executions");
    }

    // Simulate a tick that died mid-flight long ago.
    await getDb(env)
      .prepare(
        `UPDATE workflow_executions
           SET status = 'processing', locked_at = '2000-01-01T00:00:00.000Z', attempt_count = 1
         WHERE id IN (?, ?)`
      )
      .bind(recordExec.id, mintExec.id)
      .run();

    const result = await runDueWorkflowExecutions(env);
    // The record execution is recovered (attempt refunded) and immediately re-run.
    expect(result.recovered).toBe(1);
    expect(result.succeeded).toBe(1);

    const recoveredMint = await repo.getExecutionById({
      executionId: mintExec.id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
    });
    // The interrupted mint may already have landed on-chain — it must come back to a
    // human, never be blindly re-dispatched.
    expect(recoveredMint?.status).toBe("failed");
    expect(recoveredMint?.error).toBe("STALE_RECOVERED_NEEDS_REVIEW");
  });

  it("notify resolves legacy admin roles and dedupes across retries", async () => {
    // seedRule only types record/allowlist_add/mint — notify goes through the repo.
    await createAssetWorkflowsRepository(env).createWorkflow({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      triggerType: "kyc_approved",
      actionType: "notify",
      definition: {
        condition: null,
        action: { type: "notify", params: { audience: "admins" } },
        retryPolicy: { maxAttempts: 5, retryAfterMinutes: 5 },
      },
      version: 1,
      reviewMode: "auto",
      createdBy: TEST_USER.id,
    });
    // Legacy Clerk-style role value — the audience query must still resolve it.
    await getDb(env)
      .prepare(
        `INSERT INTO organization_members (id, organization_id, user_id, role, status)
         VALUES ('om_engine_test', ?, ?, 'org:admin', 'active')
         ON CONFLICT (organization_id, user_id) DO UPDATE SET role = 'org:admin'`
      )
      .bind(TEST_ORG.id, TEST_USER.id)
      .run();

    const wallet = await seedVerifiedEnrolledWallet();
    await emitKycApprovedForClearedEnrollments(env, { kycWallet: wallet });

    const result = await runDueWorkflowExecutions(env);
    expect(result.succeeded).toBe(1);

    const countNotifications = async () => {
      const row = await getDb(env)
        .prepare("SELECT COUNT(*)::int AS n FROM notifications WHERE organization_id = ?")
        .bind(TEST_ORG.id)
        .first<{ n: number }>();
      return row?.n ?? 0;
    };
    expect(await countNotifications()).toBe(1);

    // A manual re-run must not duplicate the recipient's notification (dedupe key).
    const repo = createWorkflowExecutionsRepository(env);
    const { rows } = await repo.listExecutions({
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      limit: 10,
      offset: 0,
    });
    await getDb(env)
      .prepare("UPDATE workflow_executions SET status = 'failed' WHERE id = ?")
      .bind(rows[0].id)
      .run();
    await repo.retryExecution({
      executionId: rows[0].id,
      organizationId: TEST_ORG.id,
      projectId: TEST_PROJECT_ID,
      tokenId: TEST_TOKEN_ID,
      decidedBy: TEST_USER.id,
    });
    const rerun = await runDueWorkflowExecutions(env);
    expect(rerun.succeeded).toBe(1);
    expect(await countNotifications()).toBe(1);
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

  // A tick's rule/gate caches are shared across every tenant in the batch, while both
  // lookups they memoize are tenant-scoped. Keyed on the bare id, the second tenant to
  // ask for the same id gets the first tenant's answer and skips the predicate entirely.
  //
  // The rows below are inserted through the repository exactly as written, which is the
  // point: nothing rejects an execution whose organization_id disagrees with the owner of
  // its workflow_id or token_id. The table's organization_id and workflow_id foreign keys
  // are separate constraints, so only the cache key can hold that line.
  describe("per-tick cache is scoped to the tenant", () => {
    const FOREIGN_ORG_ID = "org_workflow_cache_foreign";
    const FOREIGN_PROJECT_ID = "prj_workflow_cache_foreign";
    const FOREIGN_TOKEN_ID = "tok_workflow_cache_foreign";
    // Five in-tenant rows saturate the worker pool (CONCURRENCY = 5) ahead of the sixth,
    // so the foreign row is always shifted off the queue after a cache entry is written.
    const IN_TENANT_ROWS = 5;

    beforeEach(async () => {
      const db = getDb(env);
      await db
        .prepare(
          "INSERT OR REPLACE INTO organizations (id, name, slug, tier, status) VALUES (?, 'Foreign Org', ?, 'individual', 'active')"
        )
        .bind(FOREIGN_ORG_ID, FOREIGN_ORG_ID)
        .run();
      await db
        .prepare(
          `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
           VALUES (?, ?, 'Foreign Project', ?, 'sandbox', 'active', ?)`
        )
        .bind(FOREIGN_PROJECT_ID, FOREIGN_ORG_ID, FOREIGN_PROJECT_ID, TEST_USER.id)
        .run();
      await db
        .prepare(
          `INSERT INTO issued_tokens (id, organization_id, project_id, name, symbol, created_by)
           VALUES (?, ?, ?, 'Foreign Token', 'FRN', ?)`
        )
        .bind(FOREIGN_TOKEN_ID, FOREIGN_ORG_ID, FOREIGN_PROJECT_ID, TEST_USER.id)
        .run();
    });

    async function seedInTenantExecutions(workflowId: string) {
      const repo = createWorkflowExecutionsRepository(env);
      for (let index = 0; index < IN_TENANT_ROWS; index += 1) {
        await repo.createExecution({
          organizationId: TEST_ORG.id,
          projectId: TEST_PROJECT_ID,
          workflowId,
          tokenId: TEST_TOKEN_ID,
          triggerType: "kyc_approved",
          actionType: "record",
          status: "pending",
          idempotencyKey: `in-tenant-${index}`,
          triggerPayload: {},
          maxAttempts: 5,
        });
      }
    }

    async function statusOf(executionId: string) {
      const row = await getDb(env)
        .prepare("SELECT status, error FROM workflow_executions WHERE id = ?")
        .bind(executionId)
        .first<{ status: string; error: string | null }>();
      return row;
    }

    it("does not serve one tenant's rule to another tenant's execution", async () => {
      const rule = await seedRule();
      if (!rule) {
        throw new Error("failed to seed rule");
      }
      await seedInTenantExecutions(rule.id);

      // Same workflow_id, different owner — the exact key collision the cache had.
      const foreign = await createWorkflowExecutionsRepository(env).createExecution({
        organizationId: FOREIGN_ORG_ID,
        projectId: FOREIGN_PROJECT_ID,
        workflowId: rule.id,
        tokenId: TEST_TOKEN_ID,
        triggerType: "kyc_approved",
        actionType: "record",
        status: "pending",
        idempotencyKey: "foreign-rule-probe",
        triggerPayload: {},
        maxAttempts: 5,
      });
      if (!foreign) {
        throw new Error("failed to seed foreign execution");
      }

      await runDueWorkflowExecutions(env);

      // getWorkflowById is scoped to (id, org, project), so the foreign tenant has no
      // such rule. Anything but RULE_NOT_FOUND means it read through the cache.
      expect(await statusOf(foreign.id)).toEqual({ status: "failed", error: "RULE_NOT_FOUND" });
    });

    it("does not serve one tenant's asset gate to another tenant's execution", async () => {
      const rule = await seedRule();
      if (!rule) {
        throw new Error("failed to seed rule");
      }
      await seedInTenantExecutions(rule.id);

      // The foreign tenant owns this rule, so loadRule resolves and the run reaches
      // loadGate — where the token id belongs to the in-tenant token already cached.
      const foreignRule = await createAssetWorkflowsRepository(env).createWorkflow({
        organizationId: FOREIGN_ORG_ID,
        projectId: FOREIGN_PROJECT_ID,
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
      if (!foreignRule) {
        throw new Error("failed to seed foreign rule");
      }
      const foreign = await createWorkflowExecutionsRepository(env).createExecution({
        organizationId: FOREIGN_ORG_ID,
        projectId: FOREIGN_PROJECT_ID,
        workflowId: foreignRule.id,
        tokenId: TEST_TOKEN_ID,
        triggerType: "kyc_approved",
        actionType: "record",
        status: "pending",
        idempotencyKey: "foreign-gate-probe",
        triggerPayload: {},
        maxAttempts: 5,
      });
      if (!foreign) {
        throw new Error("failed to seed foreign execution");
      }

      await runDueWorkflowExecutions(env);

      expect(await statusOf(foreign.id)).toEqual({
        status: "failed",
        error: "ASSET_CONTEXT_UNAVAILABLE",
      });
    });

    it("still resolves each tenant's own rule and gate from cache", async () => {
      const rule = await seedRule();
      if (!rule) {
        throw new Error("failed to seed rule");
      }
      await seedInTenantExecutions(rule.id);

      const result = await runDueWorkflowExecutions(env);

      // The tenant-scoped key must not defeat the cache for the case it exists for:
      // repeated rows of the same rule on the same token still all run.
      expect(result.succeeded).toBe(IN_TENANT_ROWS);
      expect(result.failed).toBe(0);
    });
  });
});
