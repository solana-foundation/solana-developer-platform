import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const MIGRATION_SQL = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0132_organization_members_removed_at.sql"
  ),
  "utf8"
);

/**
 * Runs the migration over TEMP copies of the tables it touches, seeded by the
 * caller, then reads the result back before rolling everything back.
 *
 * @param seed - Inserts the fixture rows into the TEMP tables.
 * @param read - Reads what the migration left behind.
 * @returns What `read` returned.
 */
async function migrate<T>(
  seed: (client: Client) => Promise<void>,
  read: (client: Client) => Promise<T>
): Promise<T> {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE organizations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE auth_user_identities (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      email TEXT
    )`);
    await client.query(`CREATE TEMP TABLE organization_members (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE invitations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      email TEXT NOT NULL,
      status TEXT NOT NULL
    )`);
    await seed(client);
    await client.query(MIGRATION_SQL);
    return await read(client);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
}

/**
 * Reads every invitation's status keyed by id.
 *
 * @param client - Connection inside the migration transaction.
 * @returns Invitation status by id.
 */
async function invitationStatuses(client: Client): Promise<Record<string, string>> {
  const { rows } = await client.query<{ id: string; status: string }>(
    "SELECT id, status FROM invitations ORDER BY id"
  );
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

it("stamps every non-active membership with the migration time and leaves active ones unset", async () => {
  const result = await migrate(
    async (client) => {
      await client.query(`INSERT INTO organization_members (id, organization_id, user_id, status) VALUES
        ('mem_removed', 'org_a', 'usr_removed', 'removed'),
        ('mem_suspended', 'org_a', 'usr_suspended', 'suspended'),
        ('mem_active', 'org_a', 'usr_active', 'active')`);
    },
    async (client) => {
      const { rows } = await client.query<{ id: string; removed_at: string | null }>(
        "SELECT id, removed_at FROM organization_members ORDER BY id"
      );
      const {
        rows: [now],
      } = await client.query<{ value: string }>("SELECT sdp_iso_now() AS value");
      return { rows, now };
    }
  );

  expect(result.rows).toEqual([
    { id: "mem_active", removed_at: null },
    { id: "mem_removed", removed_at: result.now.value },
    { id: "mem_suspended", removed_at: result.now.value },
  ]);
});

it("revokes the pending invitations of deleted organizations only", async () => {
  const statuses = await migrate(async (client) => {
    await client.query(`INSERT INTO organizations (id, status) VALUES
      ('org_deleted', 'deleted'),
      ('org_suspended', 'suspended'),
      ('org_live', 'active')`);
    await client.query(`INSERT INTO invitations (id, organization_id, email, status) VALUES
      ('inv_deleted_pending', 'org_deleted', 'a@example.com', 'pending'),
      ('inv_deleted_accepted', 'org_deleted', 'b@example.com', 'accepted'),
      ('inv_suspended_pending', 'org_suspended', 'a@example.com', 'pending'),
      ('inv_live_pending', 'org_live', 'a@example.com', 'pending')`);
  }, invitationStatuses);

  expect(statuses).toEqual({
    inv_deleted_accepted: "accepted",
    inv_deleted_pending: "revoked",
    inv_live_pending: "pending",
    inv_suspended_pending: "pending",
  });
});

it("revokes the pending invitations of inactive members only", async () => {
  const statuses = await migrate(async (client) => {
    await client.query(`INSERT INTO organizations (id, status) VALUES
      ('org_a', 'active'),
      ('org_b', 'active')`);
    await client.query(`INSERT INTO users (id, email) VALUES
      ('usr_removed', 'Removed@Example.com'),
      ('usr_suspended', 'suspended@example.com'),
      ('usr_active', 'active@example.com'),
      ('usr_identity', 'placeholder-{{user.email}}')`);
    await client.query(`INSERT INTO auth_user_identities (id, user_id, email) VALUES
      ('aui_identity', 'usr_identity', 'identity@example.com')`);
    await client.query(`INSERT INTO organization_members (id, organization_id, user_id, status) VALUES
      ('mem_removed', 'org_a', 'usr_removed', 'removed'),
      ('mem_suspended', 'org_a', 'usr_suspended', 'suspended'),
      ('mem_active', 'org_a', 'usr_active', 'active'),
      ('mem_identity', 'org_a', 'usr_identity', 'removed'),
      ('mem_active_removed_elsewhere', 'org_b', 'usr_active', 'removed')`);
    await client.query(`INSERT INTO invitations (id, organization_id, email, status) VALUES
      ('inv_removed', 'org_a', 'removed@example.com', 'pending'),
      ('inv_suspended', 'org_a', 'suspended@example.com', 'pending'),
      ('inv_identity', 'org_a', 'identity@example.com', 'pending'),
      ('inv_active', 'org_a', 'active@example.com', 'pending'),
      ('inv_active_removed_elsewhere', 'org_b', 'active@example.com', 'pending'),
      ('inv_removed_other_org', 'org_b', 'removed@example.com', 'pending'),
      ('inv_stranger', 'org_a', 'stranger@example.com', 'pending'),
      ('inv_removed_accepted', 'org_a', 'removed@example.com', 'accepted')`);
  }, invitationStatuses);

  expect(statuses).toEqual({
    inv_active: "pending",
    inv_active_removed_elsewhere: "revoked",
    inv_identity: "revoked",
    inv_removed: "revoked",
    inv_removed_accepted: "accepted",
    inv_removed_other_org: "pending",
    inv_stranger: "pending",
    inv_suspended: "revoked",
  });
});
