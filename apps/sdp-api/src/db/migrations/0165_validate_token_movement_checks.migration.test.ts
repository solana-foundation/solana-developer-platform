import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

/** The CHECKs 0162-0164 added NOT VALID, which 0165 validates. */
const VALIDATED = [
  ["payment_requests", "payment_requests_expectation_shape"],
  ["payment_recurring_payments", "payment_recurring_payments_mandate_shape"],
  ["payment_subscription_plans", "payment_subscription_plans_mandate_shape"],
  ["token_movement_legs", "token_movement_legs_verification_reason_known"],
] as const;

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("0165 validate token movement checks", () => {
  it("leaves every token-movement CHECK validated", async () => {
    const { rows } = await client.query<{ table: string; constraint: string; validated: boolean }>(
      `SELECT rel.relname AS table, con.conname AS constraint, con.convalidated AS validated
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
        WHERE con.conname = ANY($1::text[])
        ORDER BY con.conname`,
      [VALIDATED.map(([, constraint]) => constraint)]
    );

    expect(rows).toEqual(
      [...VALIDATED]
        .sort(([, left], [, right]) => left.localeCompare(right))
        .map(([table, constraint]) => ({ table, constraint, validated: true }))
    );
  });
});
