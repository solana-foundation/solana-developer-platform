import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MoneyPrincipal } from "@/lib/money-principal";
import { adminDatabaseUrl } from "@/test/helpers/env";
import { CHECK_VIOLATION } from "@/test/helpers/migration-db";

const migrationSql = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "postgres/0226_payment_transfer_principal.sql"
  ),
  "utf8"
);
const constraint = "payment_transfers_initiated_by_principal_check";
const principals = [
  { kind: "api_key", apiKeyId: "key_0226" },
  { kind: "member", userId: "user_0226" },
  { kind: "mandate", recurringPaymentId: "rp_0226" },
  { kind: "payment_request", paymentRequestId: "preq_0226" },
] as const satisfies readonly MoneyPrincipal[];

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  await client.query(`CREATE TEMP TABLE payment_transfers (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'processing',
    initiated_by_key_id TEXT,
    provider_data JSONB NOT NULL DEFAULT '{}'::jsonb
  ) ON COMMIT DROP`);
  await client.query(`INSERT INTO payment_transfers
    (id, initiated_by_key_id, provider_data) VALUES
    ('legacy_key', 'key_legacy', '{"fireblocksTransfer":{"connectionId":"legacy"}}'),
    ('legacy_unknown', NULL, '{}')`);
  await client.query(migrationSql);
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0226 payment transfer principal", () => {
  it("leaves legacy rows unchanged and does not infer their execution principal", async () => {
    const result = await client.query(
      `SELECT id, status, initiated_by_key_id, provider_data, initiated_by_principal
         FROM payment_transfers ORDER BY id`
    );
    expect(result.rows).toEqual([
      {
        id: "legacy_key",
        status: "processing",
        initiated_by_key_id: "key_legacy",
        provider_data: { fireblocksTransfer: { connectionId: "legacy" } },
        initiated_by_principal: null,
      },
      {
        id: "legacy_unknown",
        status: "processing",
        initiated_by_key_id: null,
        provider_data: {},
        initiated_by_principal: null,
      },
    ]);
  });

  it("keeps the column nullable without a default and avoids a history scan", async () => {
    const column = await client.query(
      `SELECT a.attnotnull, pg_get_expr(d.adbin, d.adrelid) AS column_default
         FROM pg_attribute a
         LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        WHERE a.attrelid = 'pg_temp.payment_transfers'::regclass
          AND a.attname = 'initiated_by_principal'`
    );
    expect(column.rows).toEqual([{ attnotnull: false, column_default: null }]);
    const check = await client.query(
      `SELECT convalidated FROM pg_constraint
        WHERE conrelid = 'pg_temp.payment_transfers'::regclass AND conname = $1`,
      [constraint]
    );
    expect(check.rows).toEqual([{ convalidated: false }]);
  });

  it("accepts inserts and updates from the previous writer without a principal", async () => {
    await client.query(
      "INSERT INTO payment_transfers (id, initiated_by_key_id) VALUES ('old_writer', 'key_old')"
    );
    await client.query("UPDATE payment_transfers SET status = 'confirmed'");
    const result = await client.query(
      "SELECT id, initiated_by_principal FROM payment_transfers ORDER BY id"
    );
    expect(result.rows).toEqual([
      { id: "legacy_key", initiated_by_principal: null },
      { id: "legacy_unknown", initiated_by_principal: null },
      { id: "old_writer", initiated_by_principal: null },
    ]);
  });

  it.each(principals)("accepts the exact $kind principal", async (principal) => {
    await client.query(
      "INSERT INTO payment_transfers (id, initiated_by_principal) VALUES ('valid', $1::jsonb)",
      [JSON.stringify(principal)]
    );
    const result = await client.query(
      "SELECT initiated_by_principal FROM payment_transfers WHERE id = 'valid'"
    );
    expect(result.rows).toEqual([{ initiated_by_principal: principal }]);
  });

  it.each([
    { name: "JSON null", principal: null },
    { name: "array", principal: [] },
    { name: "string", principal: "key_0226" },
    { name: "number", principal: 7 },
    { name: "boolean", principal: true },
    { name: "empty object", principal: {} },
    { name: "missing kind", principal: { apiKeyId: "key_0226" } },
    { name: "unknown kind", principal: { kind: "system", apiKeyId: "key_0226" } },
    { name: "missing ID", principal: { kind: "api_key" } },
    { name: "wrong ID key", principal: { kind: "member", apiKeyId: "key_0226" } },
    { name: "empty ID", principal: { kind: "member", userId: "" } },
    { name: "whitespace ID", principal: { kind: "mandate", recurringPaymentId: " \t\r\n" } },
    { name: "Unicode whitespace ID", principal: { kind: "member", userId: "\u00a0\ufeff" } },
    { name: "numeric ID", principal: { kind: "payment_request", paymentRequestId: 7 } },
    { name: "null ID", principal: { kind: "api_key", apiKeyId: null } },
    { name: "object ID", principal: { kind: "member", userId: { id: "user_0226" } } },
    { name: "array ID", principal: { kind: "mandate", recurringPaymentId: ["rp_0226"] } },
    { name: "boolean ID", principal: { kind: "payment_request", paymentRequestId: true } },
    { name: "extra role", principal: { kind: "member", userId: "user_0226", role: "admin" } },
    {
      name: "extra authority",
      principal: { kind: "api_key", apiKeyId: "key_0226", authorities: ["all"] },
    },
    {
      name: "second variant ID",
      principal: { kind: "mandate", recurringPaymentId: "rp_0226", userId: "user_0226" },
    },
  ])("rejects $name", async ({ principal }) => {
    await expect(
      client.query(
        "INSERT INTO payment_transfers (id, initiated_by_principal) VALUES ('invalid', $1::jsonb)",
        [JSON.stringify(principal)]
      )
    ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint });
  });
});
