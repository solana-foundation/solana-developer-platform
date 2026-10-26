import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { INVITATION_STATUSES, type InvitationStatus } from "@sdp/types/organizations";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { env } from "@/test/helpers/env";
import { seedOrgProject, UNIQUE_VIOLATION } from "@/test/helpers/migration-db";

const revokeDuplicatesSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0176_invitations_revoke_duplicate_pending.sql"
  ),
  "utf8"
);
const invitationRowsSchema = z.array(
  z.object({ id: z.string(), status: z.enum(INVITATION_STATUSES) })
);

let client: Client;
let org: string;
let otherOrg: string;
let inviterId: string;

function insertInvitation(
  id: string,
  organizationId: string,
  email: string,
  status: InvitationStatus,
  createdAt: string
) {
  return client.query(
    `INSERT INTO invitations (id, organization_id, email, invited_by, token_hash, expires_at, status, created_at)
     VALUES ($1, $2, $3, $4, $1, '2099-01-01T00:00:00.000Z', $5, $6)`,
    [id, organizationId, email, inviterId, status, createdAt]
  );
}

async function readStatuses(): Promise<Record<string, InvitationStatus>> {
  const { rows } = await client.query(
    "SELECT id, status FROM invitations WHERE organization_id = ANY($1)",
    [[org, otherOrg]]
  );
  return Object.fromEntries(invitationRowsSchema.parse(rows).map((row) => [row.id, row.status]));
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
  const tenant = await seedOrgProject(client, "0176");
  org = tenant.organizationId;
  inviterId = tenant.userId;
  otherOrg = (await seedOrgProject(client, "0176_other")).organizationId;
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0176/0177 one pending invitation per address per organization", () => {
  it("0176 keeps only the newest pending invitation per organization and address", async () => {
    await client.query("DROP INDEX idx_invitations_one_pending_per_email");
    await insertInvitation("inv_oldest", org, "A@x.test", "pending", "2026-01-01T01:00Z");
    await insertInvitation("inv_newest", org, "a@X.test", "pending", "2026-01-01T03:00Z");
    await insertInvitation("inv_middle", org, "a@x.test", "pending", "2026-01-01T02:00Z");
    await insertInvitation("inv_accepted", org, "a@x.test", "accepted", "2026-01-01T04:00Z");
    await insertInvitation("inv_other_address", org, "b@x.test", "pending", "2026-01-01T01:00Z");
    await insertInvitation("inv_other_org", otherOrg, "a@x.test", "pending", "2026-01-01T01:00Z");

    await client.query(revokeDuplicatesSql);

    expect(await readStatuses()).toEqual({
      inv_oldest: "revoked",
      inv_middle: "revoked",
      inv_newest: "pending",
      inv_accepted: "accepted",
      inv_other_address: "pending",
      inv_other_org: "pending",
    });
  });

  it("0177 rejects a second pending invitation for the same address in any case", async () => {
    await insertInvitation("inv_first", org, "a@x.test", "pending", "2026-01-01T01:00Z");

    await expect(
      insertInvitation("inv_second", org, "A@X.test", "pending", "2026-01-01T02:00Z")
    ).rejects.toMatchObject({
      code: UNIQUE_VIOLATION,
      constraint: "idx_invitations_one_pending_per_email",
    });
  });

  it("0177 frees the address once the first is not pending, and in another organization", async () => {
    await insertInvitation("inv_first", org, "a@x.test", "pending", "2026-01-01T01:00Z");
    await client.query("UPDATE invitations SET status = 'revoked' WHERE id = 'inv_first'");

    await insertInvitation("inv_second", org, "A@x.test", "pending", "2026-01-01T02:00Z");
    await insertInvitation("inv_other_org", otherOrg, "a@x.test", "pending", "2026-01-01T02:00Z");

    expect(await readStatuses()).toEqual({
      inv_first: "revoked",
      inv_second: "pending",
      inv_other_org: "pending",
    });
  });
});
