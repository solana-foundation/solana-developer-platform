import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asTransactionalClient, getDb } from "@/db";
import app from "@/index";
import { createTenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import { ApiKeyService } from "@/services/api-key.service";
import { authenticateTestClerkUser } from "@/test/helpers/clerk";
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
  status: string;
  role: string;
  permissions: string | null;
  allowed_ips: string | null;
  allowed_operations: string | null;
  expires_at: string | null;
  rotation_deadline: string | null;
  rotated_from: string | null;
}

async function insertKey(
  overrides: Partial<Omit<KeyRow, "role">> & { id: string; keyHash?: string }
): Promise<void> {
  await getDb(env).execute(
    `INSERT INTO api_keys
       (id, organization_id, project_id, created_by, name, key_prefix, key_hash, role,
        permissions, allowed_ips, allowed_operations, status, expires_at, rotation_deadline,
        rotated_from)
     VALUES (?, ?, ?, ?, 'Lifecycle key', 'sk_test_lif', ?, 'api_developer', ?, ?, ?, ?, ?, ?, ?)`,
    [
      overrides.id,
      ORGANIZATION_ID,
      PROJECT_ID,
      USER_ID,
      overrides.keyHash ?? `hash_${overrides.id}`,
      overrides.permissions ?? null,
      overrides.allowed_ips ?? null,
      overrides.allowed_operations ?? null,
      overrides.status ?? "active",
      overrides.expires_at ?? null,
      overrides.rotation_deadline ?? null,
      overrides.rotated_from ?? null,
    ]
  );
}

async function readKey(id: string): Promise<KeyRow | null> {
  return getDb(env).queryOne<KeyRow>(
    `SELECT id, status, role, permissions, allowed_ips, allowed_operations, expires_at,
            rotation_deadline, rotated_from
       FROM api_keys WHERE id = ?`,
    [id]
  );
}

async function replacementsOf(id: string): Promise<KeyRow[]> {
  return getDb(env).queryMany<KeyRow>(
    `SELECT id, status, role, permissions, allowed_ips, allowed_operations, expires_at,
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

/** Lets a blocked statement reach its lock wait before the holder commits. */
async function untilWaitingOnLock(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const waiting = await getDb(env).queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock' AND datname = current_database()`
    );
    if ((waiting?.count ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("No statement started waiting on a lock");
}

const service = (db: DatabaseClient) =>
  new ApiKeyService(
    db,
    createTenantScope({ organizationId: ORGANIZATION_ID, projectId: PROJECT_ID })
  );

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
    it("copies the target's fields and bindings from the locked row", async () => {
      await insertKey({
        id: TARGET_KEY_ID,
        permissions: JSON.stringify(["payments:read"]),
        allowed_ips: JSON.stringify(["203.0.113.0/24"]),
        allowed_operations: JSON.stringify(["payment"]),
        expires_at: "2999-01-01T00:00:00.000Z",
      });
      await getDb(env).execute(
        `INSERT INTO api_key_wallet_permissions (id, api_key_id, wallet_id, permissions)
         VALUES ('akw_lifecycle_target', ?, 'wallet_lifecycle', '["wallets:read"]')`,
        [TARGET_KEY_ID]
      );

      const response = await rotate(TARGET_KEY_ID);

      expect(response.status).toBe(201);
      const [replacement] = await replacementsOf(TARGET_KEY_ID);
      expect(replacement).toMatchObject({
        status: "active",
        role: "api_developer",
        permissions: JSON.stringify(["payments:read"]),
        allowed_ips: JSON.stringify(["203.0.113.0/24"]),
        allowed_operations: JSON.stringify(["payment"]),
        expires_at: "2999-01-01T00:00:00.000Z",
      });
      expect(
        await getDb(env).queryMany(
          "SELECT wallet_id, permissions FROM api_key_wallet_permissions WHERE api_key_id = ?",
          [replacement?.id]
        )
      ).toEqual([{ wallet_id: "wallet_lifecycle", permissions: '["wallets:read"]' }]);
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
      const body = (await response.json()) as {
        data: { previousKey: { rotationDeadline: string } };
      };
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

      expect((await revoke(TARGET_KEY_ID)).status).toBe(200);

      expect((await readKey(TARGET_KEY_ID))?.status).toBe("deactivated");
      expect((await readKey(replacement?.id ?? ""))?.status).toBe("active");
      expect((await apiKeyAudits()).at(-1)).toMatchObject({
        action: "delete",
        resource_id: TARGET_KEY_ID,
      });
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

    it("waits for a rotation holding the key and then revokes only the predecessor", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      let commitRotation: () => void = () => {};
      const rotationMayCommit = new Promise<void>((resolve) => {
        commitRotation = resolve;
      });
      let rotationHoldsLock: () => void = () => {};
      const lockHeld = new Promise<void>((resolve) => {
        rotationHoldsLock = resolve;
      });

      const rotation = getDb(env).transaction(async (tx) => {
        const result = await service(asTransactionalClient(tx)).rotateApiKey(
          TARGET_KEY_ID,
          ORGANIZATION_ID,
          PROJECT_ID,
          24,
          ["*"]
        );
        rotationHoldsLock();
        await rotationMayCommit;
        return result;
      });
      await lockHeld;

      const revocation = revoke(TARGET_KEY_ID);
      await untilWaitingOnLock();
      commitRotation();
      await rotation;

      expect((await revocation).status).toBe(200);
      expect((await readKey(TARGET_KEY_ID))?.status).toBe("deactivated");
      const replacements = await replacementsOf(TARGET_KEY_ID);
      expect(replacements).toHaveLength(1);
      expect(replacements[0]?.status).toBe("active");
    });

    it("makes a rotation waiting on a revocation find no key to rotate", async () => {
      await insertKey({ id: TARGET_KEY_ID });
      let commitRevocation: () => void = () => {};
      const revocationMayCommit = new Promise<void>((resolve) => {
        commitRevocation = resolve;
      });
      let revocationHoldsLock: () => void = () => {};
      const lockHeld = new Promise<void>((resolve) => {
        revocationHoldsLock = resolve;
      });

      const revocation = getDb(env).transaction(async (tx) => {
        await service(asTransactionalClient(tx)).revokeApiKey(
          TARGET_KEY_ID,
          ORGANIZATION_ID,
          PROJECT_ID
        );
        revocationHoldsLock();
        await revocationMayCommit;
      });
      await lockHeld;

      const rotation = rotate(TARGET_KEY_ID);
      await untilWaitingOnLock();
      commitRevocation();
      await revocation;

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
          body: JSON.stringify({ name: "Lifecycle key", walletScope: "all" }),
        },
        env
      );
      expect(created.status).toBe(201);
      const { data } = (await created.json()) as { data: { apiKey: { id: string } } };
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
          body: JSON.stringify({ name: "Unaudited key", walletScope: "all" }),
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
});
