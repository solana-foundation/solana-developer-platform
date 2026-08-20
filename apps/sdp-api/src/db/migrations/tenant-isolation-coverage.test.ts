/**
 * Coverage ratchet for database-enforced tenant isolation (migration 0063).
 *
 * Every table in the live schema must either carry forced row-level security
 * with at least one policy, or be registered here as a deliberately shared
 * table with a reason. A new migration that creates a table without deciding
 * its isolation posture fails this test.
 */

import { describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

/** Tables that intentionally have no tenant boundary. */
const SHARED_TABLES: Record<string, string> = {
  schema_migrations: "migration bookkeeping, created by the runner",
  users: "global identity; tenancy lives in organization_members/project_members",
  auth_user_identities: "global Clerk identity map keyed by user",
  allowlist: "platform-operator allowlist, deliberately cross-tenant",
  earn_strategies: "shared yield catalog partitioned by environment",
  counterparty_pii_migration_state: "singleton migration phase flag",
  sponsorship_reconciliation_state: "singleton per-network failure counter",
  private_channel_settlement_observations:
    "on-chain oracle observations, deliberately unlinked from tenant intents",
};

interface TableSecurityRow {
  table_name: string;
  row_security: boolean;
  force_row_security: boolean;
  policy_count: number;
}

describe("tenant isolation coverage", () => {
  it("forces row-level security with a policy on every non-shared table", async () => {
    const rows = await env.db.queryMany<TableSecurityRow>(
      `SELECT c.relname AS table_name,
              c.relrowsecurity AS row_security,
              c.relforcerowsecurity AS force_row_security,
              (SELECT count(*)::int FROM pg_policy p WHERE p.polrelid = c.oid) AS policy_count
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY c.relname`
    );

    expect(rows.length).toBeGreaterThan(50);

    const unprotected = rows
      .filter((row) => !(row.table_name in SHARED_TABLES))
      .filter(
        (row) => !row.row_security || !row.force_row_security || Number(row.policy_count) === 0
      )
      .map((row) => row.table_name);

    expect(unprotected).toEqual([]);
  });

  it("keeps the shared-table registry free of stale entries", async () => {
    const rows = await env.db.queryMany<{ table_name: string }>(
      `SELECT c.relname AS table_name
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'`
    );
    const live = new Set(rows.map((row) => row.table_name));
    const stale = Object.keys(SHARED_TABLES).filter((table) => !live.has(table));

    expect(stale).toEqual([]);
  });
});
