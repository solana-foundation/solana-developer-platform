import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaymentRequestStatus } from "@sdp/types/payments";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION, seedOrgProject } from "@/test/helpers/migration-db";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const cancelSql = readFileSync(path.join(migrationsDir, "0186_payment_request_cancel.sql"), "utf8");
const validateSql = readFileSync(
  path.join(migrationsDir, "0189_payment_request_cancel_validate.sql"),
  "utf8"
);
const CANCELED_BY_STATUS = "payment_requests_canceled_by_only_when_canceled";
const TRANSFER_ID = "xfr_0186";
const CANCELED_AT = "2026-10-28T00:00:00.000Z";

type RequestRow = [
  status: PaymentRequestStatus,
  fulfilledByTransferId: string | null,
  canceledBy: string | null,
  canceledAt: string | null,
];

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

async function insertRequest(id: string, row: RequestRow) {
  return client.query(
    `INSERT INTO payment_requests (
       id, organization_id, project_id, wallet_id, destination_address, token, amount,
       reference, public_token, status, fulfilled_by_transfer_id, canceled_by, canceled_at
     ) VALUES ($1, $2, $3, 'wlt_0186', 'destination_0186', 'USDC', '10', $1, $1, $4, $5, $6, $7)`,
    [id, tenant.organizationId, tenant.projectId, ...row]
  );
}

async function validationOfCanceledByCheck() {
  const constraints = await client.query<{ convalidated: boolean }>(
    `SELECT convalidated FROM pg_constraint
      WHERE conrelid = 'payment_requests'::regclass AND conname = $1`,
    [CANCELED_BY_STATUS]
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
       DROP CONSTRAINT payment_requests_canceled_by_only_when_canceled,
       DROP COLUMN canceled_at,
       DROP COLUMN created_by_api_key_id,
       ADD CONSTRAINT payment_requests_canceled_by_only_when_canceled
         CHECK (canceled_by IS NULL OR status = 'canceled')`
  );
  tenant = await seedOrgProject(client, "0186");
  await client.query(
    `INSERT INTO payment_transfers (
       id, organization_id, project_id, wallet_id, source_address, destination_address,
       token, amount, type, direction, status, created_at, updated_at
     ) VALUES ($1, $2, $3, 'wlt_0186', 'source_0186', 'destination_0186', 'USDC', '10',
               'transfer', 'inbound', 'processing', $4, $4)`,
    [TRANSFER_ID, tenant.organizationId, tenant.projectId, CANCELED_AT]
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0186 payment request cancel", () => {
  it("refuses canceled_by on an awaiting_payment request", async () => {
    await client.query(cancelSql);

    await expect(
      insertRequest("pr_0186_refused", ["awaiting_payment", null, "user_0186", CANCELED_AT])
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: CANCELED_BY_STATUS });
  });

  it("accepts a paid request that keeps who canceled it and when", async () => {
    await client.query(cancelSql);

    await insertRequest("pr_0186_paid_late", ["paid", TRANSFER_ID, "user_0186", CANCELED_AT]);

    const requests = await client.query(
      "SELECT status, canceled_by, canceled_at FROM payment_requests WHERE id = 'pr_0186_paid_late'"
    );
    expect(requests.rows).toEqual([
      { status: "paid", canceled_by: "user_0186", canceled_at: CANCELED_AT },
    ]);
  });

  it("adds the canceled_by check NOT VALID and 0189 validates it over a request from before 0186", async () => {
    await client.query(
      `INSERT INTO payment_requests (
         id, organization_id, project_id, wallet_id, destination_address, token, amount,
         reference, public_token, status, fulfilled_by_transfer_id
       ) VALUES ('pr_0186_legacy', $1, $2, 'wlt_0186', 'destination_0186', 'USDC', '10',
                 'pr_0186_legacy', 'pr_0186_legacy', 'paid', $3)`,
      [tenant.organizationId, tenant.projectId, TRANSFER_ID]
    );

    await client.query(cancelSql);
    expect(await validationOfCanceledByCheck()).toEqual([{ convalidated: false }]);

    await client.query(validateSql);
    expect(await validationOfCanceledByCheck()).toEqual([{ convalidated: true }]);
  });
});
