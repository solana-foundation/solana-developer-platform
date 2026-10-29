import type { OrganizationStatus } from "@sdp/types/organizations";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import {
  expectSqlstate,
  FK_VIOLATION,
  seedOrgProject,
  UNIQUE_VIOLATION,
} from "@/test/helpers/migration-db";

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

function insertOrganization(
  id: string,
  createdByUserId: string | null,
  status: OrganizationStatus
) {
  return client.query(
    "INSERT INTO organizations (id, name, slug, created_by_user_id, status) VALUES ($1, $1, $1, $2, $3)",
    [id, createdByUserId, status]
  );
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
  tenant = await seedOrgProject(client, "0174");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0173/0174 one organization created per user", () => {
  it("rejects a second organization while the creator's first is not deleted", async () => {
    await insertOrganization("org_0174_first", tenant.userId, "suspended");

    await expect(
      insertOrganization("org_0174_second", tenant.userId, "active")
    ).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: "idx_organizations_one_created_per_user",
    });
  });

  it("frees the slot once the first organization is deleted, and refuses to revive it", async () => {
    await insertOrganization("org_0174_first", tenant.userId, "active");
    await client.query("UPDATE organizations SET status = 'deleted' WHERE id = 'org_0174_first'");

    await insertOrganization("org_0174_second", tenant.userId, "active");

    await expectSqlstate(
      client,
      () => client.query("UPDATE organizations SET status = 'active' WHERE id = 'org_0174_first'"),
      UNIQUE_VIOLATION
    );
    const { rows } = await client.query<{ id: string; status: OrganizationStatus }>(
      "SELECT id, status FROM organizations WHERE created_by_user_id = $1 ORDER BY id",
      [tenant.userId]
    );
    expect(rows).toEqual([
      { id: "org_0174_first", status: "deleted" },
      { id: "org_0174_second", status: "active" },
    ]);
  });

  it("lets legacy organizations with no recorded creator coexist", async () => {
    await insertOrganization("org_0174_legacy", null, "active");

    const { rows } = await client.query<{ id: string }>(
      "SELECT id FROM organizations WHERE created_by_user_id IS NULL AND id = ANY($1) ORDER BY id",
      [[tenant.organizationId, "org_0174_legacy"]]
    );
    expect(rows).toEqual([{ id: tenant.organizationId }, { id: "org_0174_legacy" }]);
  });

  it("rejects a creator that is not an existing user", async () => {
    await expect(
      insertOrganization("org_0174_orphan", "user_0174_unknown", "active")
    ).rejects.toMatchObject({
      code: FK_VIOLATION,
      constraint: "organizations_created_by_user_id_fkey",
    });
  });
});
