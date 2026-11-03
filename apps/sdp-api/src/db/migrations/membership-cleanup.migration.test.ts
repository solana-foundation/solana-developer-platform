import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MEMBER_STATUSES } from "@sdp/types/organizations";
import { ORGANIZATION_ROLES, type OrganizationRole } from "@sdp/types/roles";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION, seedOrgProject } from "@/test/helpers/migration-db";

function readMigration(file: string): string {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres", file),
    "utf8"
  );
}

const cleanupSql = readMigration("0178_membership_cleanup.sql");
const validateSql = readMigration("0179_membership_cleanup_validate.sql");
const memberRowsSchema = z.array(
  z.object({ id: z.string(), role: z.enum(ORGANIZATION_ROLES), status: z.enum(MEMBER_STATUSES) })
);

let client: Client;
let organizationId: string;

async function insertMember(id: string, role: string, status: string) {
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2)", [
    `user_${id}`,
    `${id}@example.test`,
  ]);
  await client.query(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, organizationId, `user_${id}`, role, status]
  );
}

async function readRoles(): Promise<Record<string, OrganizationRole>> {
  const { rows } = await client.query(
    "SELECT id, role, status FROM organization_members WHERE organization_id = $1",
    [organizationId]
  );
  return Object.fromEntries(memberRowsSchema.parse(rows).map((row) => [row.id, row.role]));
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  organizationId = (await seedOrgProject(client, "0178")).organizationId;
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0178/0179 membership cleanup", () => {
  it("0178 folds Clerk-era roles into admin and any other role into member, then 0179 validates", async () => {
    await client.query(
      `ALTER TABLE organization_members
         DROP CONSTRAINT organization_members_role_check,
         DROP CONSTRAINT organization_members_status_check`
    );
    await client.query("ALTER TABLE project_members ADD COLUMN role TEXT");
    for (const [id, role] of [
      ["om_owner", "owner"],
      ["om_clerk_admin", "org:admin"],
      ["om_clerk_owner", "org:owner"],
      ["om_clerk_member", "org:member"],
      ["om_developer", "developer"],
      ["om_admin", "admin"],
      ["om_member", "member"],
    ]) {
      await insertMember(id, role, "active");
    }

    await client.query(cleanupSql);
    await client.query(validateSql);

    expect(await readRoles()).toEqual({
      om_owner: "admin",
      om_clerk_admin: "admin",
      om_clerk_owner: "admin",
      om_clerk_member: "member",
      om_developer: "member",
      om_admin: "admin",
      om_member: "member",
    });
  });

  it.each([
    ["role org:admin", "org:admin", "active", "organization_members_role_check"],
    ["status deleted", "member", "deleted", "organization_members_status_check"],
  ])("rejects a member with %s", async (_label, role, status, constraint) => {
    await expect(insertMember("om_rejected", role, status)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint,
    });
  });

  it("0178 drops the project member role column", async () => {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'project_members' AND column_name = 'role'`
    );
    expect(rows).toEqual([]);
  });
});
