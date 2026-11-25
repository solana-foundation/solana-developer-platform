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
  await client.query("CREATE TEMP TABLE payment_transfers (id TEXT PRIMARY KEY) ON COMMIT DROP");
  await client.query(migrationSql);
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("payment transfer initiating principal constraint", () => {
  it.each(principals)("stores the exact $kind principal", async (principal) => {
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
