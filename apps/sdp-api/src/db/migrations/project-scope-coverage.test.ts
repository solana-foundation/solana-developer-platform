import { describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const EARN_FORENSIC_HISTORY =
  "ADR 0002: Earn history is forensic, so its project_id is ON DELETE SET NULL";
const DROPPED_BY_PR_2274 = "dead policy-engine table, dropped by PR #2274";

const NULLABLE_PROJECT_TABLES = {
  earn_external_wallet_transactions: EARN_FORENSIC_HISTORY,
  earn_external_wallet_withdrawal_request_transactions: EARN_FORENSIC_HISTORY,
  earn_movements: EARN_FORENSIC_HISTORY,
  earn_positions: EARN_FORENSIC_HISTORY,
  earn_provider_wallets: EARN_FORENSIC_HISTORY,
  earn_split_swap_advisories: EARN_FORENSIC_HISTORY,
  earn_vault_withdrawal_request_actions: EARN_FORENSIC_HISTORY,
  earn_vault_withdrawal_request_reservations: EARN_FORENSIC_HISTORY,
  earn_vault_withdrawal_requests: EARN_FORENSIC_HISTORY,
  api_key_control_profiles: DROPPED_BY_PR_2274,
  wallet_control_profiles: DROPPED_BY_PR_2274,
  wallet_operations: DROPPED_BY_PR_2274,
  approval_groups: DROPPED_BY_PR_2274,
  approval_requests: DROPPED_BY_PR_2274,
} as const satisfies Record<string, string>;

async function nullableProjectTables(): Promise<string[]> {
  const rows = await env.db.queryMany<{ table_name: string }>(
    `SELECT c.relname AS table_name
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND a.attname = 'project_id'
        AND NOT a.attisdropped
        AND NOT a.attnotnull
      ORDER BY c.relname`
  );
  return rows.map((row) => row.table_name);
}

describe("project scope coverage", () => {
  it("requires project_id on every table outside the nullable registry", async () => {
    const offenders = (await nullableProjectTables()).filter(
      (table) => !(table in NULLABLE_PROJECT_TABLES)
    );

    expect(offenders).toEqual([]);
  });

  it("keeps the nullable registry free of tables whose project_id is gone or required", async () => {
    const nullable = new Set(await nullableProjectTables());
    const stale = Object.keys(NULLABLE_PROJECT_TABLES).filter((table) => !nullable.has(table));

    expect(stale).toEqual([]);
  });
});
