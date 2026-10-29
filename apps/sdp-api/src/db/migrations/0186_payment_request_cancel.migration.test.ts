import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION, seedOrgProject } from "@/test/helpers/migration-db";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const cancelSql = readFileSync(path.join(migrationsDir, "0186_payment_request_cancel.sql"), "utf8");
const validateSql = readFileSync(
  path.join(migrationsDir, "0188_payment_request_cancel_validate.sql"),
  "utf8"
);
const CANCELER_CHECK = "payment_requests_canceled_by_principal_check";
const CANCELED_AT = "2026-10-28T00:00:00.000Z";

type Cancellation = [
  canceledAt: string | null,
  canceledByApiKeyId: string | null,
  canceledByUserId: string | null,
];

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

function insertPreviousImageCancel(id: string) {
  return client.query(
    `INSERT INTO payment_requests (
       id, organization_id, project_id, wallet_id, destination_address, token, amount,
       reference, public_token, status, canceled_by
     ) VALUES ($1, $2, $3, 'wlt_0186', 'destination_0186', 'USDC', '10', $1, $1, 'canceled', $4)`,
    [id, tenant.organizationId, tenant.projectId, tenant.userId]
  );
}

function insertCancel(id: string, cancellation: Cancellation) {
  return client.query(
    `INSERT INTO payment_requests (
       id, organization_id, project_id, wallet_id, destination_address, token, amount,
       reference, public_token, status, canceled_at, canceled_by_api_key_id, canceled_by_user_id
     ) VALUES ($1, $2, $3, 'wlt_0186', 'destination_0186', 'USDC', '10', $1, $1, 'canceled',
               $4, $5, $6)`,
    [id, tenant.organizationId, tenant.projectId, ...cancellation]
  );
}

async function cancelerCheckValidation() {
  const constraints = await client.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'payment_requests'::regclass AND conname = $1`,
    [CANCELER_CHECK]
  );
  return constraints.rows;
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
  await client.query(
    `ALTER TABLE payment_requests
       DROP CONSTRAINT ${CANCELER_CHECK},
       DROP COLUMN canceled_at,
       DROP COLUMN canceled_by_api_key_id,
       DROP COLUMN canceled_by_user_id`
  );
  tenant = await seedOrgProject(client, "0186");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0186 payment request cancel", () => {
  it("accepts the previous image's cancel, which names neither canceler column", async () => {
    await client.query(cancelSql);

    expect((await insertPreviousImageCancel("pr_0186_previous_image")).rowCount).toBe(1);
  });

  it.each<[string, Cancellation]>([
    ["both an API key and a member", [CANCELED_AT, "key_0186", "user_0186"]],
    ["no canceler", [CANCELED_AT, null, null]],
    ["a canceler but no canceled_at", [null, "key_0186", null]],
  ])("refuses a cancel naming %s", async (_case, cancellation) => {
    await client.query(cancelSql);

    await expect(insertCancel("pr_0186_refused", cancellation)).rejects.toMatchObject({
      code: CHECK_VIOLATION,
      constraint: CANCELER_CHECK,
    });
  });

  it("adds the canceler check NOT VALID and 0188 validates it over a cancel from before 0186", async () => {
    await insertPreviousImageCancel("pr_0186_legacy");

    await client.query(cancelSql);
    expect(await cancelerCheckValidation()).toEqual([{ convalidated: false }]);

    await client.query(validateSql);
    expect(await cancelerCheckValidation()).toEqual([{ convalidated: true }]);
  });
});
