/**
 * Coverage ratchet for database-enforced project scope (migration 0129).
 *
 * Every table in the live schema with a `project_id` column must make it NOT
 * NULL, or be registered here with the reason its rows may outlive or predate a
 * project. A new migration that adds a nullable `project_id` without deciding
 * that posture fails this test.
 */

import { describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const EARN_HISTORY_TABLES = [
  "earn_external_wallet_transactions",
  "earn_external_wallet_withdrawal_request_transactions",
  "earn_movements",
  "earn_positions",
  "earn_provider_wallets",
  "earn_split_swap_advisories",
  "earn_vault_withdrawal_request_actions",
  "earn_vault_withdrawal_request_reservations",
  "earn_vault_withdrawal_requests",
] as const;

const EARN_HISTORY_REASON =
  "Earn history outlives its project (ADR 0002): ON DELETE SET NULL (project_id) keeps the row and its environment, and the composite key to projects (id, environment) keeps the two consistent";

/** Tables whose `project_id` stays nullable, with the reason. */
const NULLABLE_PROJECT_TABLES: Record<string, string> = {
  ...Object.fromEntries(EARN_HISTORY_TABLES.map((table) => [table, EARN_HISTORY_REASON])),
  provider_credentials:
    "organization-scope credentials carry no project; provider_credentials_scope_check pairs scope with project_id",
  api_key_control_profiles:
    "0010 policy foundation allowing organization-level profiles; no application reader or writer remains",
  wallet_control_profiles:
    "0010 policy foundation allowing organization-level profiles; no application reader or writer remains",
  approval_groups:
    "0010 policy foundation allowing organization-level groups; no application reader or writer remains",
  approval_requests:
    "0010 policy history kept on project delete (ON DELETE SET NULL); no application reader or writer remains",
  wallet_operations:
    "0010 policy history kept on project delete (ON DELETE SET NULL); no application reader or writer remains",
};

interface ProjectColumnRow {
  table_name: string;
  not_null: boolean;
}

interface ProjectEnvironmentKeyRow {
  table_name: string;
  referenced_columns: string[];
  set_null_columns: string[];
  on_update: string;
  on_delete: string;
}

/**
 * Reads every public table carrying a `project_id` column, with its nullability.
 *
 * @returns One row per table, ordered by name.
 */
function projectColumns(): Promise<ProjectColumnRow[]> {
  return env.db.queryMany<ProjectColumnRow>(
    `SELECT c.relname AS table_name, a.attnotnull AS not_null
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'project_id' AND NOT a.attisdropped
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`
  );
}

describe("project scope coverage", () => {
  it("makes project_id NOT NULL on every project-scoped table outside the registry", async () => {
    const rows = await projectColumns();

    expect(rows.length).toBeGreaterThan(40);

    const nullable = rows
      .filter((row) => !(row.table_name in NULLABLE_PROJECT_TABLES))
      .filter((row) => !row.not_null)
      .map((row) => row.table_name);

    expect(nullable).toEqual([]);
  });

  it("keeps the nullable-project registry free of stale entries", async () => {
    const rows = await projectColumns();
    const nullableTables = new Set(
      rows.filter((row) => !row.not_null).map((row) => row.table_name)
    );
    const stale = Object.keys(NULLABLE_PROJECT_TABLES).filter(
      (table) => !nullableTables.has(table)
    );

    expect(stale).toEqual([]);
  });

  it("keys every Earn history table to projects (id, environment), nulling only project_id on delete", async () => {
    const rows = await env.db.queryMany<ProjectEnvironmentKeyRow>(
      `WITH project_keys AS (
         SELECT c.relname AS table_name,
                k.confupdtype::text AS on_update,
                k.confdeltype::text AS on_delete,
                ARRAY(SELECT a.attname::text
                      FROM unnest(k.conkey) WITH ORDINALITY AS key(attnum, position)
                      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = key.attnum
                      ORDER BY key.position) AS columns,
                ARRAY(SELECT a.attname::text
                      FROM unnest(k.confkey) WITH ORDINALITY AS key(attnum, position)
                      JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = key.attnum
                      ORDER BY key.position) AS referenced_columns,
                ARRAY(SELECT a.attname::text
                      FROM unnest(k.confdelsetcols) WITH ORDINALITY AS key(attnum, position)
                      JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = key.attnum
                      ORDER BY key.position) AS set_null_columns
         FROM pg_constraint k
         JOIN pg_class c ON c.oid = k.conrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND k.contype = 'f'
           AND k.confrelid = 'projects'::regclass
           AND c.relname = ANY(?)
       )
       SELECT table_name, referenced_columns, set_null_columns, on_update, on_delete
       FROM project_keys
       WHERE columns = ARRAY['project_id', 'environment']
       ORDER BY table_name`,
      [[...EARN_HISTORY_TABLES]]
    );

    expect(rows).toEqual(
      EARN_HISTORY_TABLES.map((table) => ({
        table_name: table,
        referenced_columns: ["id", "environment"],
        set_null_columns: ["project_id"],
        on_update: "r",
        on_delete: "n",
      }))
    );
  });
});
