import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaymentRecurringPaymentStatus } from "@sdp/types/payments";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION, seedCounterparty, seedOrgProject } from "@/test/helpers/migration-db";

const REASON_CHECK = "payment_recurring_payments_paused_reason_check";
const STATUS_CHECK = "payment_recurring_payments_paused_reason_status_check";

function readMigration(file: string) {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres", file),
    "utf8"
  );
}

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

async function insertRecurringPayment(row: {
  status: PaymentRecurringPaymentStatus;
  pausedReason: string | null;
}) {
  return client.query(
    `INSERT INTO payment_recurring_payments (
       id, organization_id, project_id, source_wallet_id, source_address, counterparty_id,
       counterparty_account_id, destination_address, token, amount, period_hours,
       subscription_id, next_collection_due_at, status, paused_reason
     ) VALUES ('rp_0184', $1, $2, 'wallet_0184', 'source_0184', 'cpty_0184', 'cpa_0184',
               'destination_0184', 'mint_0184', '25', 24, 'sub_0184',
               '2026-11-01T00:00:00.000Z', $3, $4)`,
    [tenant.organizationId, tenant.projectId, row.status, row.pausedReason]
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
  await client.query(
    `ALTER TABLE payment_recurring_payments
       DROP CONSTRAINT ${REASON_CHECK},
       DROP CONSTRAINT ${STATUS_CHECK},
       DROP COLUMN paused_reason`
  );
  tenant = await seedOrgProject(client, "0184");
  await seedCounterparty(client, {
    id: "cpty_0184",
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
  });
  await client.query(
    `INSERT INTO counterparty_accounts (id, organization_id, project_id, counterparty_id, account_kind)
     VALUES ('cpa_0184', $1, $2, 'cpty_0184', 'crypto_wallet')`,
    [tenant.organizationId, tenant.projectId]
  );
  await client.query(
    `INSERT INTO payment_subscription_plans (
       id, organization_id, project_id, owner_wallet_id, owner_address, token, amount,
       period_hours, program_plan_id
     ) VALUES ('plan_0184', $1, $2, 'wallet_0184', 'source_0184', 'mint_0184', '25', 24, '184')`,
    [tenant.organizationId, tenant.projectId]
  );
  await client.query(
    `INSERT INTO payment_subscriptions (
       id, organization_id, project_id, plan_id, counterparty_id, subscriber_address
     ) VALUES ('sub_0184', $1, $2, 'plan_0184', 'cpty_0184', 'subscriber_0184')`,
    [tenant.organizationId, tenant.projectId]
  );
  await client.query(readMigration("0184_recurring_payment_paused_reason.sql"));
  await client.query(readMigration("0185_recurring_payment_paused_reason_validate.sql"));
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0184 and 0185 recurring payment paused reason", () => {
  it("validates both checks", async () => {
    const constraints = await client.query(
      `SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = 'payment_recurring_payments'::regclass AND conname IN ($1, $2)
        ORDER BY conname`,
      [REASON_CHECK, STATUS_CHECK]
    );
    expect(constraints.rows).toEqual([
      { conname: REASON_CHECK, convalidated: true },
      { conname: STATUS_CHECK, convalidated: true },
    ]);
  });

  it.each([
    { status: "paused", pausedReason: null, constraint: STATUS_CHECK },
    { status: "active", pausedReason: "failed_attempts", constraint: STATUS_CHECK },
    { status: "paused", pausedReason: "operator_paused", constraint: REASON_CHECK },
  ] as const)(
    "refuses a $status row with paused reason $pausedReason",
    async ({ status, pausedReason, constraint }) => {
      await expect(insertRecurringPayment({ status, pausedReason })).rejects.toMatchObject({
        code: CHECK_VIOLATION,
        constraint,
      });
    }
  );

  it("accepts a paused row with failed_attempts", async () => {
    await insertRecurringPayment({ status: "paused", pausedReason: "failed_attempts" });

    const stored = await client.query(
      "SELECT status, paused_reason FROM payment_recurring_payments WHERE id = 'rp_0184'"
    );
    expect(stored.rows).toEqual([{ status: "paused", paused_reason: "failed_attempts" }]);
  });
});
