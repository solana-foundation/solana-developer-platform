import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const scriptsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts"
);
const catchUpPath = path.join(
  scriptsDirectory,
  "backfill-recurring-payment-execution-identity.sql"
);
const auditPath = path.join(scriptsDirectory, "audit-recurring-payment-execution-identity.sql");

function catchUpTransaction(sql: string): string {
  const start = sql.indexOf("BEGIN;");
  const end = sql.indexOf("COMMIT;", start);
  if (start === -1 || end === -1) throw new Error("catch-up transaction is missing");
  return sql.slice(start + "BEGIN;".length, end);
}

function auditSection(sql: string, section: string, nextSection?: string): string {
  const marker = `\\echo '=== ${section}`;
  const markerIndex = sql.indexOf(marker);
  const start = markerIndex === -1 ? -1 : sql.indexOf("\n", markerIndex) + 1;
  const end = nextSection ? sql.indexOf(`\\echo '=== ${nextSection}`, start) : sql.length;
  if (start <= 0 || end === -1) throw new Error(`audit section ${section} is missing`);
  return sql.slice(start, end);
}

function withoutPsqlCommands(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
}

it("catches up exact recurring wallet pins and audits identity plus rollback blockers", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    )`);
    await client.query(`CREATE TEMP TABLE custody_connections (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY, custody_config_id TEXT, custody_connection_id TEXT,
      wallet_id TEXT NOT NULL, public_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )`);
    await client.query(`CREATE TEMP TABLE payment_recurring_payments (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      source_custody_wallet_id TEXT, source_wallet_id TEXT NOT NULL,
      source_address TEXT NOT NULL, status TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_recurring_payment_update_attempts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      recurring_payment_id TEXT NOT NULL, new_source_custody_wallet_id TEXT,
      changed_fields TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
      after_values JSONB NOT NULL DEFAULT '{}'::jsonb,
      status TEXT NOT NULL, stage TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_recurring_payment_activation_attempts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      recurring_payment_id TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_recurring_payment_lifecycle_attempts (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      recurring_payment_id TEXT NOT NULL, operation TEXT NOT NULL,
      status TEXT NOT NULL, stage TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE wallet_operations (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
      operation_type TEXT NOT NULL, status TEXT NOT NULL, custody_wallet_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE approval_requests (
      id TEXT PRIMARY KEY, wallet_operation_id TEXT NOT NULL,
      status TEXT NOT NULL
    )`);

    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id) VALUES
      ('cfg_project', 'org_a', 'prj_a'),
      ('cfg_duplicate', 'org_a', 'prj_a'),
      ('cfg_foreign', 'org_a', 'prj_b'),
      ('cfg_shadow_org', 'org_a', NULL)`);
    await client.query(`INSERT INTO custody_connections
      (id, organization_id, project_id, status) VALUES
      ('conn_project', 'org_a', 'prj_a', 'active'),
      ('conn_shadow_project', 'org_a', 'prj_a', 'deactivated')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key) VALUES
      ('cw_project', 'cfg_project', NULL, 'provider_project', 'addr_project'),
      ('cw_connection', NULL, 'conn_project', 'provider_connection', 'addr_connection'),
      ('cw_duplicate_a', 'cfg_project', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_duplicate_b', 'cfg_duplicate', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_foreign', 'cfg_foreign', NULL, 'provider_foreign', 'addr_foreign'),
      ('cw_shadow_org', 'cfg_shadow_org', NULL, 'provider_shadow', 'addr_shadow'),
      ('cw_shadow_connection', NULL, 'conn_shadow_project', 'provider_shadow', 'addr_shadow')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key, status) VALUES
      ('cw_rebound_old', 'cfg_project', 'provider_rebound', 'addr_rebound', 'inactive'),
      ('cw_rebound_new', 'cfg_duplicate', 'provider_rebound', 'addr_rebound', 'active')`);
    await client.query(`INSERT INTO payment_recurring_payments
      (id, organization_id, project_id, source_custody_wallet_id,
       source_wallet_id, source_address, status) VALUES
      ('rp_project', 'org_a', 'prj_a', NULL, 'provider_project', 'addr_project', 'activating'),
      ('rp_connection', 'org_a', 'prj_a', NULL,
       'provider_connection', 'addr_connection', 'active'),
      ('rp_ambiguous', 'org_a', 'prj_a', NULL,
       'provider_duplicate', 'addr_duplicate', 'active'),
      ('rp_pinned_ambiguous', 'org_a', 'prj_a', 'cw_duplicate_a',
       'provider_duplicate', 'addr_duplicate', 'active'),
      ('rp_pinned_rebound', 'org_a', 'prj_a', 'cw_rebound_old',
       'provider_rebound', 'addr_rebound', 'active'),
      ('rp_pinned_shadowed', 'org_a', 'prj_a', 'cw_shadow_org',
       'provider_shadow', 'addr_shadow', 'active'),
      ('rp_mismatched', 'org_a', 'prj_a', 'cw_foreign',
       'provider_project', 'addr_project', 'active')`);

    const catchUpSql = catchUpTransaction(readFileSync(catchUpPath, "utf8"));
    await client.query(catchUpSql);
    await client.query(catchUpSql);

    expect(
      (
        await client.query(
          `SELECT id, source_custody_wallet_id FROM payment_recurring_payments ORDER BY id`
        )
      ).rows
    ).toEqual([
      { id: "rp_ambiguous", source_custody_wallet_id: null },
      { id: "rp_connection", source_custody_wallet_id: "cw_connection" },
      { id: "rp_mismatched", source_custody_wallet_id: "cw_foreign" },
      { id: "rp_pinned_ambiguous", source_custody_wallet_id: "cw_duplicate_a" },
      { id: "rp_pinned_rebound", source_custody_wallet_id: "cw_rebound_old" },
      { id: "rp_pinned_shadowed", source_custody_wallet_id: "cw_shadow_org" },
      { id: "rp_project", source_custody_wallet_id: "cw_project" },
    ]);

    await client.query(`INSERT INTO payment_recurring_payment_update_attempts
      (id, organization_id, project_id, recurring_payment_id,
       new_source_custody_wallet_id, changed_fields, after_values, status, stage) VALUES
      ('update_foreign', 'org_a', 'prj_a', 'rp_project', 'cw_foreign',
       ARRAY['sourceCustodyWalletId'], '{"sourceCustodyWalletId":"cw_foreign"}'::jsonb,
       'failed', 'create_plan'),
      ('update_missing', 'org_a', 'prj_a', 'rp_project', NULL,
       ARRAY['sourceCustodyWalletId'], '{"sourceCustodyWalletId":"cw_project"}'::jsonb,
       'failed', 'claim'),
      ('update_legacy_missing', 'org_a', 'prj_a', 'rp_project', NULL,
       ARRAY['sourceWalletId'], '{"sourceWalletId":"provider_project"}'::jsonb,
       'failed', 'claim'),
      ('update_legacy_processing', 'org_a', 'prj_a', 'rp_project', NULL,
       ARRAY['sourceWalletId'], '{"sourceWalletId":"provider_project"}'::jsonb,
       'processing', 'claim')`);

    await client.query(`INSERT INTO payment_recurring_payments
      (id, organization_id, project_id, source_custody_wallet_id,
       source_wallet_id, source_address, status) VALUES
      ('rp_updating', 'org_a', 'prj_a', 'cw_project',
       'provider_project', 'addr_project', 'updating'),
      ('rp_canceling', 'org_a', 'prj_a', 'cw_project',
       'provider_project', 'addr_project', 'canceling'),
      ('rp_resuming', 'org_a', 'prj_a', 'cw_project',
       'provider_project', 'addr_project', 'resuming')`);
    await client.query(`INSERT INTO payment_recurring_payment_activation_attempts
      (id, organization_id, project_id, recurring_payment_id, status, stage) VALUES
      ('activation_processing', 'org_a', 'prj_a', 'rp_project', 'processing', 'create_plan'),
      ('activation_confirmed', 'org_a', 'prj_a', 'rp_project', 'confirmed', 'finalize')`);
    await client.query(`INSERT INTO payment_recurring_payment_update_attempts
      (id, organization_id, project_id, recurring_payment_id,
       new_source_custody_wallet_id, status, stage) VALUES
      ('update_processing', 'org_a', 'prj_a', 'rp_updating',
       'cw_project', 'processing', 'update_plan')`);
    await client.query(`INSERT INTO payment_recurring_payment_lifecycle_attempts
      (id, organization_id, project_id, recurring_payment_id,
       operation, status, stage) VALUES
      ('lifecycle_processing', 'org_a', 'prj_a', 'rp_canceling',
       'cancel', 'processing', 'submit'),
      ('lifecycle_failed', 'org_a', 'prj_a', 'rp_resuming',
       'resume', 'failed', 'submit')`);
    await client.query(`INSERT INTO wallet_operations
      (id, organization_id, project_id, operation_type, status) VALUES
      ('operation_pending', 'org_a', 'prj_a', 'recurring_payment_create', 'pending_approval'),
      ('operation_executing', 'org_a', 'prj_a', 'recurring_payment_update', 'executing'),
      ('operation_collection', 'org_a', 'prj_a', 'recurring_payment_collection', 'executing'),
      ('operation_terminal', 'org_a', 'prj_a', 'recurring_payment_collection', 'completed'),
      ('operation_rejected', 'org_a', 'prj_a', 'recurring_payment_create', 'pending_approval'),
      ('operation_other', 'org_a', 'prj_a', 'payment_transfer_execute', 'pending_approval')`);
    await client.query(`INSERT INTO approval_requests
      (id, wallet_operation_id, status) VALUES
      ('approval_pending', 'operation_pending', 'pending'),
      ('approval_approved', 'operation_executing', 'approved'),
      ('approval_collection', 'operation_collection', 'approved'),
      ('approval_terminal', 'operation_terminal', 'approved'),
      ('approval_rejected', 'operation_rejected', 'rejected'),
      ('approval_other', 'operation_other', 'pending')`);

    const auditSql = readFileSync(auditPath, "utf8");
    await client.query(withoutPsqlCommands(auditSql));
    expect((await client.query(auditSection(auditSql, "1b.", "2."))).rows).toEqual([
      {
        evidence_match_count: 2,
        id: "rp_ambiguous",
        legacy_custody_wallet_id: null,
        organization_id: "org_a",
        project_id: "prj_a",
        provider_match_count: 2,
        source_custody_wallet_id: null,
        status: "active",
      },
      {
        evidence_match_count: 1,
        id: "rp_mismatched",
        legacy_custody_wallet_id: "cw_project",
        organization_id: "org_a",
        project_id: "prj_a",
        provider_match_count: 1,
        source_custody_wallet_id: "cw_foreign",
        status: "active",
      },
      {
        evidence_match_count: 2,
        id: "rp_pinned_ambiguous",
        legacy_custody_wallet_id: null,
        organization_id: "org_a",
        project_id: "prj_a",
        provider_match_count: 2,
        source_custody_wallet_id: "cw_duplicate_a",
        status: "active",
      },
      {
        evidence_match_count: 1,
        id: "rp_pinned_rebound",
        legacy_custody_wallet_id: "cw_rebound_new",
        organization_id: "org_a",
        project_id: "prj_a",
        provider_match_count: 1,
        source_custody_wallet_id: "cw_rebound_old",
        status: "active",
      },
      {
        evidence_match_count: 2,
        id: "rp_pinned_shadowed",
        legacy_custody_wallet_id: null,
        organization_id: "org_a",
        project_id: "prj_a",
        provider_match_count: 2,
        source_custody_wallet_id: "cw_shadow_org",
        status: "active",
      },
    ]);
    const mismatchRows = await client.query<{ id: string; resource: string }>(
      auditSection(auditSql, "2.", "2a.")
    );
    expect(mismatchRows.rows).toEqual(
      expect.arrayContaining([
        { custody_wallet_id: "cw_foreign", id: "rp_mismatched", resource: "recurring_payment" },
        { custody_wallet_id: "cw_foreign", id: "update_foreign", resource: "update_attempt" },
      ])
    );
    expect((await client.query(auditSection(auditSql, "2a.", "2b."))).rows).toEqual([
      {
        id: "update_legacy_processing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_project",
        stage: "claim",
        status: "processing",
      },
      {
        id: "update_missing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_project",
        stage: "claim",
        status: "failed",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "2b.", "3."))).rows).toEqual([
      {
        id: "update_legacy_missing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_project",
        stage: "claim",
        status: "failed",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "3.", "4."))).rows).toEqual([
      {
        id: "rp_canceling",
        organization_id: "org_a",
        project_id: "prj_a",
        status: "canceling",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "rp_project",
        organization_id: "org_a",
        project_id: "prj_a",
        status: "activating",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "rp_resuming",
        organization_id: "org_a",
        project_id: "prj_a",
        status: "resuming",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "rp_updating",
        organization_id: "org_a",
        project_id: "prj_a",
        status: "updating",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "4.", "5."))).rows).toEqual([
      {
        attempt_kind: "activation",
        id: "activation_processing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_project",
        stage: "create_plan",
        status: "processing",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        attempt_kind: "lifecycle",
        id: "lifecycle_processing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_canceling",
        stage: "submit",
        status: "processing",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        attempt_kind: "update",
        id: "update_legacy_processing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_project",
        stage: "claim",
        status: "processing",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
      {
        attempt_kind: "update",
        id: "update_processing",
        organization_id: "org_a",
        project_id: "prj_a",
        recurring_payment_id: "rp_updating",
        stage: "update_plan",
        status: "processing",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "5."))).rows).toEqual([
      {
        approval_request_id: "approval_collection",
        approval_status: "approved",
        custody_wallet_id: null,
        operation_status: "executing",
        operation_type: "recurring_payment_collection",
        organization_id: "org_a",
        project_id: "prj_a",
        wallet_operation_id: "operation_collection",
      },
      {
        approval_request_id: "approval_approved",
        approval_status: "approved",
        custody_wallet_id: null,
        operation_status: "executing",
        operation_type: "recurring_payment_update",
        organization_id: "org_a",
        project_id: "prj_a",
        wallet_operation_id: "operation_executing",
      },
      {
        approval_request_id: "approval_pending",
        approval_status: "pending",
        custody_wallet_id: null,
        operation_status: "pending_approval",
        operation_type: "recurring_payment_create",
        organization_id: "org_a",
        project_id: "prj_a",
        wallet_operation_id: "operation_pending",
      },
    ]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
