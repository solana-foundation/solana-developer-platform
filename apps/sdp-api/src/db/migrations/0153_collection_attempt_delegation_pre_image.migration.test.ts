import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PaymentSubscriptionCollectionAttemptStatus } from "@sdp/types/payments";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION, seedCounterparty, seedOrgProject } from "@/test/helpers/migration-db";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0153_collection_attempt_delegation_pre_image.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
const SUBSCRIPTION_ID = "sub_0153";
const PRE_IMAGE_CONSTRAINT = "payment_subscription_collection_attempts_pre_image_check";
const PRE_IMAGE_BACKFILL_ERROR =
  "Collection attempt predates the delegation pre-image (migration 0153)";
const SEEDED_UPDATED_AT = "2025-12-31T00:00:00.000Z";

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

async function insertAttempt(attempt: {
  id: string;
  periodStartTsBefore: string | null;
  amountPulledBefore: string | null;
}) {
  return client.query(
    `INSERT INTO payment_subscription_collection_attempts (
       id, organization_id, project_id, subscription_id, token, amount, due_at, metadata,
       delegation_period_start_ts_before, delegation_amount_pulled_before
     ) VALUES ($1, $2, $3, $4, 'mint_0153', '25', '2026-01-02T00:00:00.000Z', '{"source":"automated"}', $5, $6)`,
    [
      attempt.id,
      tenant.organizationId,
      tenant.projectId,
      SUBSCRIPTION_ID,
      attempt.periodStartTsBefore,
      attempt.amountPulledBefore,
    ]
  );
}

async function preImagesOfSubscription() {
  const result = await client.query<{
    id: string;
    delegation_period_start_ts_before: string | null;
    delegation_amount_pulled_before: string | null;
  }>(
    `SELECT id,
            delegation_period_start_ts_before::text AS delegation_period_start_ts_before,
            delegation_amount_pulled_before::text AS delegation_amount_pulled_before
       FROM payment_subscription_collection_attempts
      WHERE subscription_id = $1
      ORDER BY id`,
    [SUBSCRIPTION_ID]
  );
  return result.rows;
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  await client.query(
    `ALTER TABLE payment_subscription_collection_attempts
       DROP CONSTRAINT payment_subscription_collection_attempts_pre_image_check,
       DROP COLUMN delegation_period_start_ts_before,
       DROP COLUMN delegation_amount_pulled_before`
  );

  tenant = await seedOrgProject(client, "0153");
  await seedCounterparty(client, {
    id: "cpty_0153",
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
  });
  await client.query(
    `INSERT INTO payment_subscription_plans (
       id, organization_id, project_id, owner_wallet_id, owner_address,
       token, amount, period_hours, program_plan_id
     ) VALUES ('plan_0153', $1, $2, 'wallet_0153', 'owner_0153', 'mint_0153', '25', 24, '153')`,
    [tenant.organizationId, tenant.projectId]
  );
  await client.query(
    `INSERT INTO payment_subscriptions (
       id, organization_id, project_id, plan_id, counterparty_id, subscriber_address
     ) VALUES ($1, $2, $3, 'plan_0153', 'cpty_0153', 'subscriber_0153')`,
    [SUBSCRIPTION_ID, tenant.organizationId, tenant.projectId]
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0153 collection attempt delegation pre-image", () => {
  it("fails an in-flight signed attempt without a pre-image and leaves unsigned and confirmed attempts", async () => {
    await client.query(
      `INSERT INTO payment_subscription_collection_attempts (
         id, organization_id, project_id, subscription_id, token, amount, due_at,
         status, signature, metadata, updated_at
       ) VALUES
         ('psca_0153_confirmed_signed', $1, $2, $3, 'mint_0153', '25', '2026-01-01T00:00:00.000Z',
          'confirmed', 'sig_0153_confirmed', '{"source":"automated"}', $4),
         ('psca_0153_pending_signed', $1, $2, $3, 'mint_0153', '25', '2026-01-02T00:00:00.000Z',
          'pending', 'sig_0153_pending', '{"source":"automated"}', $4),
         ('psca_0153_processing_signed', $1, $2, $3, 'mint_0153', '25', '2026-01-03T00:00:00.000Z',
          'processing', 'sig_0153_processing', '{"source":"automated"}', $4),
         ('psca_0153_processing_unsigned', $1, $2, $3, 'mint_0153', '25', '2026-01-04T00:00:00.000Z',
          'processing', NULL, '{"source":"automated"}', $4)`,
      [tenant.organizationId, tenant.projectId, SUBSCRIPTION_ID, SEEDED_UPDATED_AT]
    );

    await client.query(migrationSql);

    const attempts = await client.query<{
      id: string;
      status: PaymentSubscriptionCollectionAttemptStatus;
      error: string | null;
      updated_at_unchanged: boolean;
    }>(
      `SELECT id, status, error, updated_at = $2 AS updated_at_unchanged
         FROM payment_subscription_collection_attempts
        WHERE subscription_id = $1
        ORDER BY id`,
      [SUBSCRIPTION_ID, SEEDED_UPDATED_AT]
    );
    expect(attempts.rows).toEqual([
      {
        id: "psca_0153_confirmed_signed",
        status: "confirmed",
        error: null,
        updated_at_unchanged: true,
      },
      {
        id: "psca_0153_pending_signed",
        status: "failed",
        error: PRE_IMAGE_BACKFILL_ERROR,
        updated_at_unchanged: false,
      },
      {
        id: "psca_0153_processing_signed",
        status: "failed",
        error: PRE_IMAGE_BACKFILL_ERROR,
        updated_at_unchanged: false,
      },
      {
        id: "psca_0153_processing_unsigned",
        status: "processing",
        error: null,
        updated_at_unchanged: true,
      },
    ]);
  });

  it("leaves an attempt written before the migration without a pre-image and accepts a new one without", async () => {
    await client.query(
      `INSERT INTO payment_subscription_collection_attempts (
         id, organization_id, project_id, subscription_id, token, amount, due_at, metadata
       ) VALUES ('psca_0153_legacy', $1, $2, $3, 'mint_0153', '25',
                 '2026-01-01T00:00:00.000Z', '{"source":"automated"}')`,
      [tenant.organizationId, tenant.projectId, SUBSCRIPTION_ID]
    );

    await client.query(migrationSql);
    await insertAttempt({
      id: "psca_0153_unsigned",
      periodStartTsBefore: null,
      amountPulledBefore: null,
    });

    expect(await preImagesOfSubscription()).toEqual([
      {
        id: "psca_0153_legacy",
        delegation_period_start_ts_before: null,
        delegation_amount_pulled_before: null,
      },
      {
        id: "psca_0153_unsigned",
        delegation_period_start_ts_before: null,
        delegation_amount_pulled_before: null,
      },
    ]);
  });

  it.each([
    { periodStartTsBefore: "-9223372036854775808", amountPulledBefore: "18446744073709551615" },
    { periodStartTsBefore: "1767225600", amountPulledBefore: "0" },
  ])(
    "accepts a pre-image of period start $periodStartTsBefore and amount pulled $amountPulledBefore",
    async ({ periodStartTsBefore, amountPulledBefore }) => {
      await client.query(migrationSql);

      await insertAttempt({
        id: "psca_0153_signed",
        periodStartTsBefore,
        amountPulledBefore,
      });

      expect(await preImagesOfSubscription()).toEqual([
        {
          id: "psca_0153_signed",
          delegation_period_start_ts_before: periodStartTsBefore,
          delegation_amount_pulled_before: amountPulledBefore,
        },
      ]);
    }
  );

  it.each([
    { periodStartTsBefore: "1767225600", amountPulledBefore: null },
    { periodStartTsBefore: null, amountPulledBefore: "25" },
  ])(
    "refuses a half pre-image of period start $periodStartTsBefore and amount pulled $amountPulledBefore",
    async ({ periodStartTsBefore, amountPulledBefore }) => {
      await client.query(migrationSql);

      await expect(
        insertAttempt({
          id: "psca_0153_half",
          periodStartTsBefore,
          amountPulledBefore,
        })
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: PRE_IMAGE_CONSTRAINT });
    }
  );

  it.each(["-1", "18446744073709551616", "1.5"])(
    "refuses %s as the amount pulled through the sdp_u64 domain",
    async (amountPulledBefore) => {
      await client.query(migrationSql);

      await expect(
        insertAttempt({
          id: "psca_0153_out_of_range",
          periodStartTsBefore: "1767225600",
          amountPulledBefore,
        })
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "sdp_u64_check" });
    }
  );
});
