import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

/**
 * Revokes exactly the self-reinstatement tokens (pending invitations of
 * inactive members) — everything else is somebody's live workflow.
 */
it("revokes pending invitations only where the invited member is inactive", async () => {
  const migrationPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0056_revoke_pending_invitations_of_inactive_members.sql"
  );
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
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

    await client.query(`INSERT INTO users (id, email) VALUES
      ('usr_removed', 'Removed@Example.com'),
      ('usr_active', 'active@example.com'),
      ('usr_identity', 'placeholder-{{user.email}}')`);
    // Real address only on the auth identity — which acceptance would match too.
    await client.query(`INSERT INTO auth_user_identities (id, user_id, email) VALUES
      ('aui_identity', 'usr_identity', 'identity@example.com')`);
    await client.query(`INSERT INTO organization_members (id, organization_id, user_id, status) VALUES
      ('mem_removed', 'org_a', 'usr_removed', 'removed'),
      ('mem_active', 'org_a', 'usr_active', 'active'),
      ('mem_identity', 'org_a', 'usr_identity', 'removed'),
      ('mem_other_org', 'org_b', 'usr_active', 'removed')`);
    await client.query(`INSERT INTO invitations (id, organization_id, email, status) VALUES
      ('inv_stale', 'org_a', 'removed@example.com', 'pending'),
      ('inv_active_member', 'org_a', 'active@example.com', 'pending'),
      ('inv_identity_match', 'org_a', 'identity@example.com', 'pending'),
      ('inv_no_member', 'org_a', 'stranger@example.com', 'pending'),
      ('inv_wrong_org', 'org_c', 'removed@example.com', 'pending'),
      ('inv_other_org_removed', 'org_b', 'active@example.com', 'pending'),
      ('inv_already_spent', 'org_a', 'removed@example.com', 'accepted')`);

    await client.query(sql);

    const { rows } = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM invitations ORDER BY id"
    );
    const statusById = new Map(rows.map((row) => [row.id, row.status]));

    // Inactive member in the invitation's org → revoked (case-insensitive,
    // users.email or auth identity).
    expect(statusById.get("inv_stale")).toBe("revoked");
    expect(statusById.get("inv_identity_match")).toBe("revoked");
    expect(statusById.get("inv_other_org_removed")).toBe("revoked");

    // Live workflows stay live.
    expect(statusById.get("inv_active_member")).toBe("pending");
    expect(statusById.get("inv_no_member")).toBe("pending");
    expect(statusById.get("inv_wrong_org")).toBe("pending");

    // Not pending, nothing to revoke.
    expect(statusById.get("inv_already_spent")).toBe("accepted");
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
