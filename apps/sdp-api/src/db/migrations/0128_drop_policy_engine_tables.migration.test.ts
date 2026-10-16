import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adminDatabaseUrl as databaseUrl } from "@/test/helpers/env";
import { POLICY_ENGINE_DROP_MIGRATION } from "./policy-engine-schema";

// The test database is fully migrated by src/test/node-global-setup.ts, so these
// assertions read the schema 0128 leaves behind.

const migrationSql = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres", POLICY_ENGINE_DROP_MIGRATION),
  "utf8"
);

const DROPPED_TABLES = [
  "api_key_control_profile_revisions",
  "api_key_control_profiles",
  "api_key_wallet_policy_bindings",
  "approval_group_members",
  "approval_groups",
  "approval_requests",
  "policy_evaluations",
  "policy_provider_sync_status",
  "wallet_control_profile_revisions",
  "wallet_control_profiles",
  "wallet_operations",
] as const;

let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: databaseUrl });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

async function tableExists(name: string): Promise<boolean> {
  const result = await client.query<{ regclass: string | null }>(
    "SELECT to_regclass($1) AS regclass",
    [`public.${name}`]
  );
  return result.rows[0]?.regclass !== null;
}

describe("0128 drop policy engine tables", () => {
  it("is declared breaking, so CI holds it to a migrations-only pull request", () => {
    expect(migrationSql).toMatch(/^-- sdp:migration-compat: breaking$/m);
  });

  it.each(DROPPED_TABLES)("drops %s", async (table) => {
    expect(await tableExists(table)).toBe(false);
  });

  it("keeps the Earn sponsorship budget policy tables, which are unrelated", async () => {
    expect(await tableExists("sponsorship_budget_policies")).toBe(true);
    expect(await tableExists("sponsorship_budget_policy_revisions")).toBe(true);
  });

  it("drops the two Rings approval columns and keeps the rest of the row", async () => {
    const result = await client.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'helius_rings_operations'`
    );
    const columns = result.rows.map((row) => row.column_name);

    expect(columns).not.toContain("approval_request_id");
    expect(columns).not.toContain("policy_evaluation_id");
    expect(columns).toEqual(
      expect.arrayContaining(["id", "state", "retry_of_operation_id", "initiated_by_key_id"])
    );
  });

  it("leaves the Rings state check alone, so a stored approval_required row stays valid", async () => {
    const result = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = 'helius_rings_operations'::regclass
          AND conname = 'helius_rings_operations_state_check'`
    );

    expect(result.rows[0]?.definition).toContain("approval_required");
  });

  it("can run again against a database that already dropped everything", async () => {
    await client.query("BEGIN");
    try {
      await expect(client.query(migrationSql)).resolves.toBeDefined();
    } finally {
      await client.query("ROLLBACK");
    }
  });
});
