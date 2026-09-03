/**
 * Approved-operation replay must not authenticate an API key whose project has
 * been archived, even when the key row itself is still active (the pre-backfill
 * state for projects archived before archival revoked keys).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getDb } from "@/db";
import { recoverApprovedWalletOperations } from "@/services/policy/approved-operation-replay";
import { TEST_ORG, TEST_USER } from "@/test/fixtures/organizations";
import { env } from "@/test/helpers/env";
import { seedTestDatabase } from "@/test/mocks/db";

const PROJECT_ID = "prj_replay_archived";
const API_KEY_ID = "key_replay_archived";
const OPERATION_ID = "wop_replay_archived";
const APPROVAL_ID = "appr_replay_archived";
const WALLET_ID = "wal_replay_archived";

async function seedStuckApprovedOperation(projectStatus: string): Promise<void> {
  const db = getDb(env);
  await db.batch([
    db
      .prepare(
        `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
         VALUES (?, ?, 'Replay Test Project', 'replay-test-project', 'sandbox', ?, ?)`
      )
      .bind(PROJECT_ID, TEST_ORG.id, projectStatus, TEST_USER.id),
    db
      .prepare(
        `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role, permissions, status)
         VALUES (?, ?, ?, ?, 'Replay Test Key', 'sk_test_replay', 'hash_replay_archived', 'api_admin', '["*"]', 'active')`
      )
      .bind(API_KEY_ID, TEST_ORG.id, PROJECT_ID, TEST_USER.id),
    db
      .prepare(
        `INSERT INTO wallet_operations
         (id, organization_id, project_id, wallet_id, api_key_id, operation_family, operation_type,
          raw_payload, status, execution_started_at, execution_lease_expires_at)
         VALUES (?, ?, ?, ?, ?, 'payment', 'payment_transfer_execute', ?, 'executing', ?, ?)`
      )
      .bind(
        OPERATION_ID,
        TEST_ORG.id,
        PROJECT_ID,
        WALLET_ID,
        API_KEY_ID,
        JSON.stringify({
          executionRequest: {
            method: "POST",
            path: "/v1/payments/transfers",
            body: { source: WALLET_ID, destination: "test", token: "SOL", amount: "1" },
            idempotencyKey: "idem-replay-archived",
          },
        }),
        "2020-01-01T00:00:00.000Z",
        "2020-01-01T00:00:01.000Z"
      ),
    db
      .prepare(
        `INSERT INTO approval_requests
         (id, organization_id, project_id, wallet_operation_id, status, requested_by, resolved_by)
         VALUES (?, ?, ?, ?, 'approved', ?, ?)`
      )
      .bind(APPROVAL_ID, TEST_ORG.id, PROJECT_ID, OPERATION_ID, TEST_USER.id, TEST_USER.id),
  ]);
}

describe("approved-operation replay on archived projects", () => {
  beforeEach(async () => {
    const db = getDb(env);
    await db.prepare("DELETE FROM approval_requests WHERE id = ?").bind(APPROVAL_ID).run();
    await db.prepare("DELETE FROM wallet_operations WHERE id = ?").bind(OPERATION_ID).run();
    await db.prepare("DELETE FROM api_keys WHERE id = ?").bind(API_KEY_ID).run();
    await db.prepare("DELETE FROM projects WHERE id = ?").bind(PROJECT_ID).run();
  });

  beforeAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);

    const db = getDb(env);
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
  });

  afterAll(async () => {
    await seedTestDatabase(env as Parameters<typeof seedTestDatabase>[0]);
  });

  it("fails recovery when the API key's project is archived but the key row is still active", async () => {
    await seedStuckApprovedOperation("archived");

    await recoverApprovedWalletOperations(env);

    const operation = await getDb(env)
      .prepare("SELECT status, execution_error FROM wallet_operations WHERE id = ?")
      .bind(OPERATION_ID)
      .first<{ status: string; execution_error: string | null }>();
    expect(operation?.status).toBe("failed");
    expect(operation?.execution_error).toContain("Original API key is no longer active");
  });

  it("still recovers the same operation shape when the project is active", async () => {
    // Sanity control: the seeding itself is valid, and replay proceeds far
    // enough to leave the executing state (it fails later on transfer
    // validation, not on authentication).
    await seedStuckApprovedOperation("active");

    await recoverApprovedWalletOperations(env);

    const operation = await getDb(env)
      .prepare("SELECT status, execution_error FROM wallet_operations WHERE id = ?")
      .bind(OPERATION_ID)
      .first<{ status: string; execution_error: string | null }>();
    expect(operation?.status).not.toBe("executing");
    expect(operation?.execution_error).not.toContain("no longer active");
  });
});
