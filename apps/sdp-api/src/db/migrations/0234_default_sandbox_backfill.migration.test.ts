import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { MemberStatus, OrganizationStatus } from "@sdp/types/organizations";
import type { OrganizationRole } from "@sdp/types/roles";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { env } from "@/test/helpers/env";
import { seedOrgProject } from "@/test/helpers/migration-db";

const backfillSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres",
    "0234_default_sandbox_backfill.sql"
  ),
  "utf8"
);
const sandboxRowsSchema = z.array(
  z.object({ id: z.string(), slug: z.string(), status: z.string(), created_by: z.string() })
);
const seatRowsSchema = z.array(z.object({ user_id: z.string() }));

let client: Client;

/** An organization admitted on a mainnet-only deployment: its production project alone. */
async function seedMainnetOnlyOrganization(tag: string, status: OrganizationStatus = "active") {
  const seeded = await seedOrgProject(client, tag);
  await client.query("UPDATE organizations SET status = $2 WHERE id = $1", [
    seeded.organizationId,
    status,
  ]);
  await client.query("DELETE FROM projects WHERE id = $1", [seeded.projectId]);
  await addMember(seeded.organizationId, seeded.userId, "admin", "active");
  return seeded;
}

async function addMember(
  organizationId: string,
  userId: string,
  role: OrganizationRole,
  status: MemberStatus
) {
  await client.query("INSERT INTO users (id, email) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
    userId,
    `${userId}@example.test`,
  ]);
  await client.query(
    `INSERT INTO organization_members (id, organization_id, user_id, role, status)
     VALUES ($1, $2, $3, $4, $5)`,
    [`om_${userId}`, organizationId, userId, role, status]
  );
}

async function sandboxProjects(organizationId: string) {
  const { rows } = await client.query(
    `SELECT id, slug, status, created_by FROM projects
      WHERE organization_id = $1 AND environment = 'sandbox'`,
    [organizationId]
  );
  return sandboxRowsSchema.parse(rows);
}

async function seats(projectId: string) {
  const { rows } = await client.query(
    "SELECT user_id FROM project_members WHERE project_id = $1 ORDER BY user_id",
    [projectId]
  );
  return seatRowsSchema.parse(rows).map((row) => row.user_id);
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
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0234 default sandbox backfill", () => {
  it("gives a mainnet-only organization its default sandbox project and seats every active member", async () => {
    const { organizationId, userId } = await seedMainnetOnlyOrganization("0234_mainnet");
    await addMember(organizationId, "user_0234_member", "member", "active");
    await addMember(organizationId, "user_0234_removed", "member", "removed");

    await client.query(backfillSql);

    const [sandbox] = await sandboxProjects(organizationId);
    expect(sandbox).toMatchObject({
      slug: "default-sandbox",
      status: "active",
      created_by: userId,
    });
    expect(await seats(sandbox.id)).toEqual([userId, "user_0234_member"].sort());
  });

  it("leaves an organization that already has its sandbox project as it is", async () => {
    const { organizationId, projectId, userId } = await seedOrgProject(client, "0234_both");
    await addMember(organizationId, userId, "admin", "active");

    await client.query(backfillSql);
    await client.query(backfillSql);

    expect((await sandboxProjects(organizationId)).map((project) => project.id)).toEqual([
      projectId,
    ]);
    expect(await seats(projectId)).toEqual([userId]);
  });

  it("skips organizations being provisioned or deleted, and organizations with no active member", async () => {
    const provisioning = await seedMainnetOnlyOrganization("0234_provisioning", "provisioning");
    const deleted = await seedMainnetOnlyOrganization("0234_deleted", "deleted");
    const empty = await seedOrgProject(client, "0234_empty");
    await client.query("DELETE FROM projects WHERE id = $1", [empty.projectId]);

    await client.query(backfillSql);

    for (const { organizationId } of [provisioning, deleted, empty]) {
      expect(await sandboxProjects(organizationId)).toEqual([]);
    }
  });
});
