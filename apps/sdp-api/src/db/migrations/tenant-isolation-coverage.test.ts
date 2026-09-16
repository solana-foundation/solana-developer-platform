/**
 * Coverage ratchet for database-enforced tenant isolation (migration 0079).
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
  sponsorship_reconciliation_state: "singleton per-network failure counter",
  private_channel_settlement_observations:
    "on-chain oracle observations, deliberately unlinked from tenant intents",
  earn_execution_models: "shared movement vocabulary (0062_earn_movements)",
  earn_movement_directions: "shared movement vocabulary (0062_earn_movements)",
  earn_movement_statuses: "shared movement vocabulary (0062_earn_movements)",
  helius_rings_asset_allowlist: "platform reference data seeded by 0057_helius_rings",
  ramp_webhook_events:
    "system webhook inbox; rows are persisted before tenant resolution and only system jobs read them",
};

/**
 * Functions that widen their own read to a privileged isolation identity via a
 * function-level SET. Each is a cross-tenant fact by definition and collapses
 * to a figure no tenant row can leak through; a new one needs a reason here.
 */
const IDENTITY_SETTING_FUNCTIONS: Record<string, string> = {
  earn_vault_deposit_exposure:
    "ADR 0004 vault exposure cap: SDP-wide deposits into one vault, summed across " +
    "organizations inside the ledger write's own transaction (0101)",
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

  it("makes every view run with the invoker's row-level security", async () => {
    // A default (owner-rights) view reads its underlying tables as the
    // migration role, letting a tenant see straight through RLS. Every view
    // must therefore opt into security_invoker.
    const views = await env.db.queryMany<{ view_name: string; options: string[] | null }>(
      `SELECT c.relname AS view_name, c.reloptions AS options
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'v'
       ORDER BY c.relname`
    );

    const ownerRights = views
      .filter((view) => !(view.options ?? []).some((option) => option === "security_invoker=true"))
      .map((view) => view.view_name);

    expect(ownerRights).toEqual([]);
  });

  it("lets only registered functions set the isolation identity for themselves", async () => {
    // A function-level `SET app.tenant_isolation_identity` runs its body as a
    // privileged identity regardless of the caller's. That is the one way a
    // tenant-stamped transaction can read across organizations, so every
    // function that does it is registered above with a reason, and the
    // registry cannot go stale either.
    const rows = await env.db.queryMany<{ function_name: string; config: string[] | null }>(
      `SELECT p.proname AS function_name, p.proconfig AS config
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proconfig IS NOT NULL
       ORDER BY p.proname`
    );
    const identitySetting = rows
      .filter((row) =>
        (row.config ?? []).some((entry) => entry.startsWith("app.tenant_isolation_identity="))
      )
      .map((row) => row.function_name);

    expect(identitySetting).toEqual(Object.keys(IDENTITY_SETTING_FUNCTIONS).sort());
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
