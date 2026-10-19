import type { ApiKeyStatus } from "@sdp/types/api-keys";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { getDb } from "@/db/client";
import { app } from "@/index";
import { getLogger } from "@/runtime/logger";
import { authenticateTestClerkUser } from "@/test/helpers/clerk";
import { seedTestCustodyRows } from "@/test/helpers/custody";
import { env } from "@/test/helpers/env";
import { seedDefaultProjects } from "@/test/helpers/projects";
import { seedTestDatabase } from "@/test/mocks/db";
import { clearKVStores } from "@/test/mocks/kv";

/**
 * Key lifecycle rules (HOO-2099): rotation and revocation of one key serialize
 * on its row, a dead predecessor is never revived, a deadline never moves
 * later, and every lifecycle change commits with its audit record or not at all.
 */
const ORGANIZATION_ID = "org_api_key_lifecycle";
const PROJECT_ID = "prj_api_key_lifecycle";
const USER_ID = "usr_api_key_lifecycle";
const TARGET_KEY_ID = "key_lifecycle_target";
const AUDIT_FAILURE_CONSTRAINT = "sdp_test_fail_api_key_audit";

let headers: Record<string, string>;

interface KeyRow {
  id: string;
  status: ApiKeyStatus;
  grants: string[];
  allowed_ips: string | null;
  expires_at: string | null;
  rotation_deadline: string | null;
  rotated_from: string | null;
}

async function insertKey(
  overrides: Partial<KeyRow> & { id: string; keyHash?: string }
): Promise<void> {
  await getDb(env).execute(
    `INSERT INTO api_keys
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash, grants, allowed_ips, status, expires_at, rotation_deadline,
        rotated_from)
     VALUES (?, ?, ?, ?, 'Lifecycle key', 'sk_test_lif', ?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.id,
      ORGANIZATION_ID,
      PROJECT_ID,
      USER_ID,
      overrides.keyHash ?? `hash_${overrides.id}`,
      overrides.grants ?? [],
      overrides.allowed_ips ?? null,
      overrides.status ?? "active",
      overrides.expires_at ?? null,
      overrides.rotation_deadline ?? null,
      overrides.rotated_from ?? null,
    ]
  );
}

async function readKey(id: string): Promise<KeyRow | null> {
  return getDb(env).queryOne<KeyRow>(
    `SELECT id, status, grants, allowed_ips, expires_at,
            rotation_deadline, rotated_from
       FROM api_keys WHERE id = ?`,
    [id]
  );
}

async function replacementsOf(id: string): Promise<KeyRow[]> {
  return getDb(env).queryMany<KeyRow>(
    `SELECT id, status, grants, allowed_ips, expires_at,
            rotation_deadline, rotated_from
       FROM api_keys WHERE rotated_from = ? ORDER BY created_at, id`,
    [id]
  );
}

async function apiKeyAudits(): Promise<
  Array<{ action: string; resource_id: string; metadata: string }>
> {
  return getDb(env).queryMany(
    `SELECT action, resource_id, metadata FROM audit_logs
      WHERE resource_type = 'api_key' ORDER BY ledger_sequence`
  );
}

function rotate(keyId: string, gracePeriodHours = 24) {
  return app.request(
    `/v1/api-keys/${keyId}/rotate`,
    { method: "POST", headers, body: JSON.stringify({ gracePeriodHours }) },
    env
  );
}

function revoke(keyId: string) {
  return app.request(
    `/v1/api-keys/${keyId}`,
    { method: "DELETE", headers, body: JSON.stringify({ confirmation: "Lifecycle key" }) },
    env
  );
}

/**
 * Waits until a statement containing `fragment` is blocked on a lock in this
 * worker's database. Matching the statement text, not any lock waiter, keeps
 * an unrelated wait from satisfying it.
 */
async function untilWaitingOn(fragment: string): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const waiting = await getDb(env).queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND datname = current_database()
          AND pid <> pg_backend_pid()
          AND position($1 in query) > 0`,
      [fragment]
    );
    if (!waiting) throw new Error("COUNT(*) returned no row");
    if (waiting.count > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`No statement containing ${fragment} started waiting on a lock`);
}

/**
 * Holds the target key's row lock in a transaction of its own until
 * `release` is called, so real requests queue behind it in a chosen order.
 */
async function holdKeyRow(keyId: string): Promise<{ release: () => Promise<void> }> {
  let release: () => void = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let locked: () => void = () => {};
  const holding = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const transaction = getDb(env).transaction(async (tx) => {
    await tx.execute("SELECT id FROM api_keys WHERE id = ? FOR UPDATE", [keyId]);
    locked();
    await released;
  });
  await holding;
  return {
    release: async () => {
      release();
      await transaction;
    },
  };
}

describe("API key lifecycle", () => {
  beforeEach(async () => {
    await seedTestDatabase(env);
    await clearKVStores(env);
    const db = getDb(env);
    await db.batch([
      db
        .prepare(
          "INSERT INTO organizations (id, name, slug, tier, status) VALUES (?, 'Lifecycle', 'api-key-lifecycle', 'individual', 'active')"
        )
        .bind(ORGANIZATION_ID),
      db
        .prepare(
          "INSERT INTO users (id, email, email_verified, status) VALUES (?, 'lifecycle@example.com', 1, 'active')"
        )
        .bind(USER_ID),
    ]);
    const session = await authenticateTestClerkUser(env, db, {
      userId: USER_ID,
      email: "lifecycle@example.com",
      clerkUserId: `clerk_${USER_ID}`,
      organizationId: ORGANIZATION_ID,
      clerkOrgId: `clerk_${ORGANIZATION_ID}`,
      orgSlug: "api-key-lifecycle",
      role: "admin",
    });
    headers = session.headers(PROJECT_ID);
    await seedDefaultProjects(db, {
      organizationId: ORGANIZATION_ID,
      createdBy: USER_ID,
      members: [USER_ID],
      ids: { sandbox: PROJECT_ID, production: `${PROJECT_ID}_production` },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await getDb(env).execute(
      `ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS ${AUDIT_FAILURE_CONSTRAINT}`
    );
  });

  describe("rotation", () => {
    it("copies the target's fields and wallet scope from the locked row", async () => {
      await insertKey({
        id: TARGET_KEY_ID,
        grants: ["transfers.read"],
        allowed_ips: JSON.stringify(["203.0.113.0/24"]),
        expires_at: "2999-01-01T00:00:00.000Z",
      });
      await seedTestCustodyRows(env, {
        configs: [
          {
            id: "cust_lifecycle",
            organizationId: ORGANIZATION_ID,
            projectId: PROJECT_ID,
            provider: "local",
            configEncrypted: "test-config",
            status: "active",
          },
        ],
        wallets: [
          {
            id: "cwlt_lifecycle",
            owner: { kind: "config", custodyConfigId: "cust_lifecycle" },
            walletId: "wallet_lifecycle",
            publicKey: "wallet_lifecycle_public_key",
            label: null,
            purpose: null,
            status: "active",
          },
        ],
      });
      await getDb(env).execute("UPDATE api_keys SET wallet_scope = 'selected' WHERE id = ?", [
        TARGET_KEY_ID,
      ]);
      await getDb(env).execute(
        `INSERT INTO api_key_signing_wallets (api_key_id, custody_wallet_id)
         VALUES (?, 'cwlt_lifecycle')`,
        [TARGET_KEY_ID]
      );

      const response = await rotate(TARGET_KEY_ID);

      expect(response.status).toBe(201);
      const [replacement] = await replacementsOf(TARGET_KEY_ID);
      expect(replacement).toMatchObject({
        status: "active",
        grants: ["transfers.read"],
        allowed_ips: JSON.stringify(["203.0.113.0/24"]),
        expires_at: "2999-01-01T00:00:00.000Z",
      });
      expect(
        await getDb(env).queryMany(
          `SELECT ak.wallet_scope, s.custody_wallet_id
             FROM api_keys ak JOIN api_key_signing_wallets s ON s.api_key_id = ak.id
            WHERE ak.id = ?`,
          [replacement?.id]
        )
      ).toEqual([{ wallet_scope: "selected", custody_wallet_id: "cwlt_lifecycle" }]);
    });

    it("keeps a key that predates grants unmarked through rotation, until grants are set", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      await getDb(env).execute("UPDATE api_keys SET grants_assigned = false WHERE id = ?", [
        TARGET_KEY_ID,
      ]);
      const grantsAssigned = async (id: string | undefined) =>
        (
          await getDb(env).queryOne<{ grants_assigned: boolean }>(
            "SELECT grants_assigned FROM api_keys WHERE id = ?",
            [id]
          )
        )?.grants_assigned;

      expect((await rotate(TARGET_KEY_ID)).status).toBe(201);
      const [replacement] = await replacementsOf(TARGET_KEY_ID);
      expect(await grantsAssigned(replacement?.id)).toBe(false);

      const response = await app.request(
        `/v1/api-keys/${replacement?.id}`,
        { method: "PATCH", headers, body: JSON.stringify({ grants: ["transfers.read"] }) },
        env
      );
      expect(response.status).toBe(200);
      expect(await grantsAssigned(replacement?.id)).toBe(true);
    });

    it("refuses to revive a predecessor past its deadline whose replacement was revoked", async () => {
      const deadline = new Date(Date.now() - 60_000).toISOString();
      await insertKey({ id: TARGET_KEY_ID, rotation_deadline: deadline });
      await insertKey({
        id: "key_lifecycle_revoked_child",
        status: "deactivated",
        rotated_from: TARGET_KEY_ID,
      });

      const response = await rotate(TARGET_KEY_ID);

      expect(response.status).toBe(409);
      expect((await readKey(TARGET_KEY_ID))?.rotation_deadline).toBe(deadline);
      expect((await replacementsOf(TARGET_KEY_ID)).map((key) => key.status)).toEqual([
        "deactivated",
      ]);
    });

    it("refuses to rotate an expired key", async () => {
      await insertKey({ id: TARGET_KEY_ID, expires_at: "2020-01-01T00:00:00.000Z" });

      expect((await rotate(TARGET_KEY_ID)).status).toBe(409);
      expect(await replacementsOf(TARGET_KEY_ID)).toEqual([]);
    });

    it("never moves a running deadline later", async () => {
      const deadline = new Date(Date.now() + 60 * 60_000).toISOString();
      await insertKey({ id: TARGET_KEY_ID, rotation_deadline: deadline });
      await insertKey({
        id: "key_lifecycle_lost_child",
        status: "deactivated",
        rotated_from: TARGET_KEY_ID,
      });

      const response = await rotate(TARGET_KEY_ID, 168);

      expect(response.status).toBe(201);
      const body = z
        .object({ data: z.object({ previousKey: z.object({ rotationDeadline: z.string() }) }) })
        .parse(await response.json());
      expect(body.data.previousKey.rotationDeadline).toBe(deadline);
      expect((await readKey(TARGET_KEY_ID))?.rotation_deadline).toBe(deadline);
    });

    it("answers a second rotation with the first one's replacement", async () => {
      await insertKey({ id: TARGET_KEY_ID });

      const [first, second] = await Promise.all([rotate(TARGET_KEY_ID), rotate(TARGET_KEY_ID)]);

      expect([first.status, second.status].sort()).toEqual([201, 409]);
      expect(await replacementsOf(TARGET_KEY_ID)).toHaveLength(1);
    });
  });

  describe("revocation", () => {
    // Rotate, deploy the replacement, then retire the old key early.
    it("revokes only the predecessor during its grace period", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      expect((await rotate(TARGET_KEY_ID)).status).toBe(201);
      const [replacement] = await replacementsOf(TARGET_KEY_ID);
      if (!replacement) throw new Error("Expected rotation replacement");

      expect((await revoke(TARGET_KEY_ID)).status).toBe(200);

      expect((await readKey(TARGET_KEY_ID))?.status).toBe("deactivated");
      expect((await readKey(replacement.id))?.status).toBe("active");
      expect((await apiKeyAudits()).at(-1)).toMatchObject({
        action: "delete",
        resource_id: TARGET_KEY_ID,
      });
    });

    it("answers a repeat revocation with the time it was revoked", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      const first = await revoke(TARGET_KEY_ID);
      const second = await revoke(TARGET_KEY_ID);

      const revokedAt = z.object({ data: z.object({ revokedAt: z.string() }) });
      expect(revokedAt.parse(await second.json()).data.revokedAt).toBe(
        revokedAt.parse(await first.json()).data.revokedAt
      );
    });

    it("refuses to report a revocation for an expired key that was never revoked", async () => {
      await insertKey({ id: TARGET_KEY_ID, status: "expired" });

      expect((await revoke(TARGET_KEY_ID)).status).toBe(409);
      expect((await readKey(TARGET_KEY_ID))?.status).toBe("expired");
    });

    it("leaves the replacement of a retired predecessor alone", async () => {
      await insertKey({
        id: TARGET_KEY_ID,
        rotation_deadline: new Date(Date.now() - 60_000).toISOString(),
      });
      await insertKey({ id: "key_lifecycle_live_child", rotated_from: TARGET_KEY_ID });

      expect((await revoke(TARGET_KEY_ID)).status).toBe(200);

      expect((await readKey("key_lifecycle_live_child"))?.status).toBe("active");
    });

    // Both requests run through their real handlers (rotation inside the
    // audit ledger's transaction) and queue on the key's row lock in order.
    it("revokes only the predecessor when a rotation queued first", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      const holder = await holdKeyRow(TARGET_KEY_ID);

      const rotation = rotate(TARGET_KEY_ID);
      await untilWaitingOn("FOR UPDATE OF ak");
      const revocation = revoke(TARGET_KEY_ID);
      await untilWaitingOn("SET status = 'deactivated'");
      await holder.release();

      expect((await rotation).status).toBe(201);
      expect((await revocation).status).toBe(200);
      expect((await readKey(TARGET_KEY_ID))?.status).toBe("deactivated");
      expect((await replacementsOf(TARGET_KEY_ID)).map((key) => key.status)).toEqual(["active"]);
    });

    it("rotates nothing when a revocation queued first", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      const holder = await holdKeyRow(TARGET_KEY_ID);

      const revocation = revoke(TARGET_KEY_ID);
      await untilWaitingOn("SET status = 'deactivated'");
      const rotation = rotate(TARGET_KEY_ID);
      await untilWaitingOn("FOR UPDATE OF ak");
      await holder.release();

      expect((await revocation).status).toBe(200);
      expect((await rotation).status).toBe(404);
      expect(await replacementsOf(TARGET_KEY_ID)).toEqual([]);
    });
  });

  describe("audit", () => {
    async function failApiKeyAudits(): Promise<void> {
      await getDb(env).execute(
        `ALTER TABLE audit_logs ADD CONSTRAINT ${AUDIT_FAILURE_CONSTRAINT}
           CHECK (resource_type IS DISTINCT FROM 'api_key') NOT VALID`
      );
    }

    it("writes each lifecycle change with its audit record", async () => {
      const created = await app.request(
        "/v1/api-keys",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Lifecycle key",
            grants: ["transfers.read"],
            walletScope: "all",
          }),
        },
        env
      );
      expect(created.status).toBe(201);
      const { data } = z
        .object({ data: z.object({ apiKey: z.object({ id: z.string() }) }) })
        .parse(await created.json());
      expect((await rotate(data.apiKey.id)).status).toBe(201);
      expect((await revoke(data.apiKey.id)).status).toBe(200);

      expect((await apiKeyAudits()).map((audit) => audit.action)).toEqual([
        "create",
        "update",
        "delete",
      ]);
    });

    it("creates no key and returns no secret when the audit write fails", async () => {
      await failApiKeyAudits();

      const response = await app.request(
        "/v1/api-keys",
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            name: "Unaudited key",
            grants: ["transfers.read"],
            walletScope: "all",
          }),
        },
        env
      );

      expect(response.status).toBe(500);
      expect(await response.text()).not.toMatch(/sk_test_/);
      expect(
        await getDb(env).queryMany("SELECT id FROM api_keys WHERE name = 'Unaudited key'")
      ).toEqual([]);
    });

    it("rolls a rotation back and returns no secret when the audit write fails", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      await failApiKeyAudits();

      const response = await rotate(TARGET_KEY_ID);

      expect(response.status).toBe(500);
      expect(await response.text()).not.toMatch(/sk_test_/);
      expect(await replacementsOf(TARGET_KEY_ID)).toEqual([]);
      expect((await readKey(TARGET_KEY_ID))?.rotation_deadline).toBeNull();
    });

    // A reduction of authority never waits on the ledger: the key is revoked
    // and the missing record is reported to operators.
    it("revokes the key even when the audit write fails, and reports it", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      await failApiKeyAudits();
      const error = vi.spyOn(getLogger(), "error");

      expect((await revoke(TARGET_KEY_ID)).status).toBe(200);
      expect((await readKey(TARGET_KEY_ID))?.status).toBe("deactivated");
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "sdp_audit_reduction_unaudited",
          resourceId: TARGET_KEY_ID,
        }),
        expect.any(String)
      );
    });

    it("leaves the key unchanged when the update's audit write fails", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      await failApiKeyAudits();

      const response = await app.request(
        `/v1/api-keys/${TARGET_KEY_ID}`,
        { method: "PATCH", headers, body: JSON.stringify({ allowedIps: ["203.0.113.0/24"] }) },
        env
      );

      expect(response.status).toBe(500);
      expect((await readKey(TARGET_KEY_ID))?.allowed_ips).toBeNull();
    });
  });

  it.each([
    ["role", "api_developer"],
    ["permissions", ["payments:read"]],
    ["allowedOperations", ["payment"]],
  ])(
    "refuses an update naming the retired %s field and leaves the key as it was",
    async (field, value) => {
      await insertKey({ id: TARGET_KEY_ID, grants: ["transfers.execute"] });

      const response = await app.request(
        `/v1/api-keys/${TARGET_KEY_ID}`,
        { method: "PATCH", headers, body: JSON.stringify({ name: "ci", [field]: value }) },
        env
      );

      expect(response.status).toBe(400);
      const body = z
        .object({ error: z.object({ message: z.string() }) })
        .parse(await response.json());
      expect(body.error.message).toContain(`${field} is no longer accepted: send grants`);
      expect((await readKey(TARGET_KEY_ID))?.grants).toEqual(["transfers.execute"]);
    }
  );
});
