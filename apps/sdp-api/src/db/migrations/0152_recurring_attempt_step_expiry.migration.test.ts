import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";
import { CHECK_VIOLATION, seedCounterparty, seedOrgProject } from "@/test/helpers/migration-db";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0152_recurring_attempt_step_expiry.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
const RECURRING_PAYMENT_ID = "rp_0152";

interface AttemptTable {
  table: string;
  constraint: string;
  fixedColumns: Readonly<Record<string, string>>;
  signatureSlots: readonly string[];
}

const ACTIVATION_ATTEMPTS = {
  table: "payment_recurring_payment_activation_attempts",
  constraint: "payment_recurring_activation_attempts_expiry_signature_check",
  fixedColumns: { stage: "claim" },
  signatureSlots: [
    "plan_creation_signature",
    "authorization_setup_signature",
    "authorization_signature",
  ],
} as const satisfies AttemptTable;
const UPDATE_ATTEMPTS = {
  table: "payment_recurring_payment_update_attempts",
  constraint: "payment_recurring_update_attempts_expiry_signature_check",
  fixedColumns: { mode: "replacement", status: "processing", stage: "claim" },
  signatureSlots: [
    "plan_update_signature",
    "plan_creation_signature",
    "authorization_setup_signature",
    "authorization_signature",
    "old_cancel_signature",
  ],
} as const satisfies AttemptTable;
const LIFECYCLE_ATTEMPTS = {
  table: "payment_recurring_payment_lifecycle_attempts",
  constraint: "payment_recurring_lifecycle_attempts_expiry_signature_check",
  fixedColumns: { operation: "cancel", status: "processing", stage: "claim" },
  signatureSlots: ["signature"],
} as const satisfies AttemptTable;
const ATTEMPT_TABLES = [ACTIVATION_ATTEMPTS, UPDATE_ATTEMPTS, LIFECYCLE_ATTEMPTS];

type AttemptTableFixture = (typeof ATTEMPT_TABLES)[number];
type KeysOf<T> = T extends unknown ? keyof T : never;
type AttemptColumn =
  | "id"
  | "organization_id"
  | "project_id"
  | "recurring_payment_id"
  | "last_valid_block_height"
  | KeysOf<AttemptTableFixture["fixedColumns"]>
  | AttemptTableFixture["signatureSlots"][number];

let client: Client;
let tenant: Awaited<ReturnType<typeof seedOrgProject>>;

async function insertAttempt<Table extends AttemptTableFixture>(attempt: {
  attemptTable: Table;
  id: string;
  signatureSlot: Table["signatureSlots"][number] | null;
  lastValidBlockHeight: string;
}) {
  const fixedColumns: AttemptTableFixture["fixedColumns"] = attempt.attemptTable.fixedColumns;
  const signatureSlot: AttemptTableFixture["signatureSlots"][number] | null = attempt.signatureSlot;
  const columns: Partial<Record<AttemptColumn, string>> = {
    id: attempt.id,
    organization_id: tenant.organizationId,
    project_id: tenant.projectId,
    recurring_payment_id: RECURRING_PAYMENT_ID,
    ...fixedColumns,
    last_valid_block_height: attempt.lastValidBlockHeight,
  };
  if (signatureSlot !== null) {
    columns[signatureSlot] = `sig_${attempt.id}`;
  }
  const names = Object.keys(columns);
  return client.query(
    `INSERT INTO ${attempt.attemptTable.table} (${names.join(", ")})
     VALUES (${names.map((_, index) => `$${index + 1}`).join(", ")})`,
    Object.values(columns)
  );
}

async function lastValidBlockHeightOf(table: string, id: string) {
  const result = await client.query<{ last_valid_block_height: string }>(
    `SELECT last_valid_block_height::text AS last_valid_block_height FROM ${table} WHERE id = $1`,
    [id]
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
    `ALTER TABLE payment_recurring_payment_activation_attempts
       DROP CONSTRAINT payment_recurring_activation_attempts_expiry_signature_check,
       DROP COLUMN last_valid_block_height,
       DROP COLUMN authorization_setup_signature`
  );
  await client.query(
    `ALTER TABLE payment_recurring_payment_update_attempts
       DROP CONSTRAINT payment_recurring_update_attempts_expiry_signature_check,
       DROP COLUMN last_valid_block_height`
  );
  await client.query(
    `ALTER TABLE payment_recurring_payment_lifecycle_attempts
       DROP CONSTRAINT payment_recurring_lifecycle_attempts_expiry_signature_check,
       DROP COLUMN last_valid_block_height`
  );
  await client.query("DROP DOMAIN sdp_u64");

  tenant = await seedOrgProject(client, "0152");
  await seedCounterparty(client, {
    id: "cpty_0152",
    organizationId: tenant.organizationId,
    projectId: tenant.projectId,
  });
  await client.query(
    `INSERT INTO counterparty_accounts (id, organization_id, project_id, counterparty_id, account_kind)
     VALUES ('cpa_0152', $1, $2, 'cpty_0152', 'crypto_wallet')`,
    [tenant.organizationId, tenant.projectId]
  );
  await client.query(
    `INSERT INTO payment_recurring_payments (
       id, organization_id, project_id, source_wallet_id, source_address,
       counterparty_id, counterparty_account_id, destination_address, token, amount, period_hours
     ) VALUES ($1, $2, $3, 'wallet_0152', 'source_0152',
               'cpty_0152', 'cpa_0152', 'destination_0152', 'mint_0152', '25', 24)`,
    [RECURRING_PAYMENT_ID, tenant.organizationId, tenant.projectId]
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0152 recurring attempt step expiry", () => {
  it("copies the activation authority-setup signature out of metadata and keeps the metadata key", async () => {
    await client.query(
      `INSERT INTO payment_recurring_payment_activation_attempts
         (id, organization_id, project_id, recurring_payment_id, stage, metadata)
       VALUES
         ('rpaa_0152_backfilled', $1, $2, $3, 'authorize_subscription',
          '{"authorizationSetupSignature":"sig_0152_setup"}'),
         ('rpaa_0152_untouched', $1, $2, $3, 'create_plan', '{}')`,
      [tenant.organizationId, tenant.projectId, RECURRING_PAYMENT_ID]
    );

    await client.query(migrationSql);

    const attempts = await client.query(
      `SELECT id, authorization_setup_signature, metadata
         FROM payment_recurring_payment_activation_attempts
        WHERE recurring_payment_id = $1
        ORDER BY id`,
      [RECURRING_PAYMENT_ID]
    );
    expect(attempts.rows).toEqual([
      {
        id: "rpaa_0152_backfilled",
        authorization_setup_signature: "sig_0152_setup",
        metadata: { authorizationSetupSignature: "sig_0152_setup" },
      },
      { id: "rpaa_0152_untouched", authorization_setup_signature: null, metadata: {} },
    ]);
  });

  it.each(["-1", "18446744073709551616", "1.5"])(
    "refuses %s as a block height through the sdp_u64 domain",
    async (lastValidBlockHeight) => {
      await client.query(migrationSql);

      await expect(
        insertAttempt({
          attemptTable: LIFECYCLE_ATTEMPTS,
          id: "rpla_0152_out_of_range",
          signatureSlot: "signature",
          lastValidBlockHeight,
        })
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "sdp_u64_check" });
    }
  );

  it.each(["0", "18446744073709551615"])(
    "accepts %s as a block height through the sdp_u64 domain",
    async (lastValidBlockHeight) => {
      await client.query(migrationSql);

      await insertAttempt({
        attemptTable: LIFECYCLE_ATTEMPTS,
        id: "rpla_0152_in_range",
        signatureSlot: "signature",
        lastValidBlockHeight,
      });

      expect(await lastValidBlockHeightOf(LIFECYCLE_ATTEMPTS.table, "rpla_0152_in_range")).toEqual([
        { last_valid_block_height: lastValidBlockHeight },
      ]);
    }
  );

  it.each(ATTEMPT_TABLES)(
    "refuses a block height on $table while every signature slot is empty",
    async (attemptTable) => {
      await client.query(migrationSql);

      await expect(
        insertAttempt({
          attemptTable,
          id: "attempt_0152_unsigned",
          signatureSlot: null,
          lastValidBlockHeight: "301",
        })
      ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: attemptTable.constraint });
    }
  );

  it.each(
    ATTEMPT_TABLES.flatMap((attemptTable) =>
      attemptTable.signatureSlots.map((signatureSlot) => ({
        table: attemptTable.table,
        attemptTable,
        signatureSlot,
      }))
    )
  )(
    "accepts a block height on $table with only $signatureSlot set",
    async ({ attemptTable, signatureSlot }) => {
      await client.query(migrationSql);

      await insertAttempt({
        attemptTable,
        id: "attempt_0152_signed",
        signatureSlot,
        lastValidBlockHeight: "301",
      });

      expect(await lastValidBlockHeightOf(attemptTable.table, "attempt_0152_signed")).toEqual([
        { last_valid_block_height: "301" },
      ]);
    }
  );
});
