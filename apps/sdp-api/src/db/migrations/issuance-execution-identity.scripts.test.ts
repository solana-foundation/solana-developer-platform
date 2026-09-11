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
const catchUpPath = path.join(scriptsDirectory, "backfill-issuance-execution-identity.sql");
const auditPath = path.join(scriptsDirectory, "audit-issuance-execution-identity.sql");

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

it("catches up only unambiguous pending Issuance drafts and audits live identity risks", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE custody_connections (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY, custody_config_id TEXT, custody_connection_id TEXT,
      wallet_id TEXT NOT NULL, public_key TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
    )`);
    await client.query(`CREATE TEMP TABLE issued_tokens (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
      signing_custody_wallet_id TEXT, signing_wallet_id TEXT, mint_address TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE issuance_transactions (
      id TEXT PRIMARY KEY, token_id TEXT NOT NULL, organization_id TEXT NOT NULL,
      custody_wallet_id TEXT, type TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE wallet_operations (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
      operation_type TEXT NOT NULL, status TEXT NOT NULL, custody_wallet_id TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);

    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id) VALUES
      ('cfg_project', 'org_a', 'prj_a'),
      ('cfg_org', 'org_a', NULL),
      ('cfg_foreign', 'org_a', 'prj_b')`);
    await client.query(`INSERT INTO custody_connections (id, organization_id, project_id) VALUES
      ('conn_project', 'org_a', 'prj_a'),
      ('conn_duplicate', 'org_a', 'prj_a')`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key) VALUES
      ('cw_project', 'cfg_project', NULL, 'provider_project', 'address_project'),
      ('cw_org', 'cfg_org', NULL, 'provider_org', 'address_org'),
      ('cw_connection', NULL, 'conn_project', 'provider_connection', 'address_connection'),
      ('cw_duplicate_a', 'cfg_project', NULL, 'provider_duplicate', 'address_duplicate_a'),
      ('cw_duplicate_b', NULL, 'conn_duplicate', 'provider_duplicate', 'address_duplicate_b'),
      ('cw_project_shadow', 'cfg_project', NULL, 'provider_shadow', 'address_project_shadow'),
      ('cw_org_shadow', 'cfg_org', NULL, 'provider_shadow', 'address_org_shadow'),
      ('cw_foreign', 'cfg_foreign', NULL, 'provider_foreign', 'address_foreign')`);
    await client.query(`INSERT INTO issued_tokens
      (id, organization_id, project_id, signing_custody_wallet_id,
       signing_wallet_id, mint_address, status) VALUES
      ('tok_project', 'org_a', 'prj_a', NULL, 'provider_project', NULL, 'pending'),
      ('tok_org', 'org_a', 'prj_a', NULL, 'provider_org', NULL, 'pending'),
      ('tok_connection', 'org_a', 'prj_a', NULL, 'provider_connection', NULL, 'pending'),
      ('tok_ambiguous', 'org_a', 'prj_a', NULL, 'provider_duplicate', NULL, 'pending'),
      ('tok_unresolved', 'org_a', 'prj_a', NULL, 'provider_missing', NULL, 'pending'),
      ('tok_no_selection', 'org_a', 'prj_a', NULL, NULL, NULL, 'pending'),
      ('tok_deployed', 'org_a', 'prj_a', NULL, 'provider_project', 'mint_a', 'active'),
      ('tok_pending_minted', 'org_a', 'prj_a', NULL, 'provider_project', 'mint_b', 'pending'),
      ('tok_existing', 'org_a', 'prj_a', 'cw_project', 'provider_project', NULL, 'pending')`);
    await client.query(`INSERT INTO issuance_transactions
      (id, token_id, organization_id, custody_wallet_id, type, status) VALUES
      ('ttx_legacy', 'tok_deployed', 'org_a', NULL, 'mint', 'confirmed')`);

    const catchUpSql = catchUpTransaction(readFileSync(catchUpPath, "utf8"));
    await client.query(catchUpSql);
    await client.query(catchUpSql);

    expect(
      (await client.query(`SELECT id, signing_custody_wallet_id FROM issued_tokens ORDER BY id`))
        .rows
    ).toEqual([
      { id: "tok_ambiguous", signing_custody_wallet_id: null },
      { id: "tok_connection", signing_custody_wallet_id: "cw_connection" },
      { id: "tok_deployed", signing_custody_wallet_id: null },
      { id: "tok_existing", signing_custody_wallet_id: "cw_project" },
      { id: "tok_no_selection", signing_custody_wallet_id: null },
      { id: "tok_org", signing_custody_wallet_id: "cw_org" },
      { id: "tok_pending_minted", signing_custody_wallet_id: null },
      { id: "tok_project", signing_custody_wallet_id: "cw_project" },
      { id: "tok_unresolved", signing_custody_wallet_id: null },
    ]);
    expect(
      (await client.query("SELECT custody_wallet_id FROM issuance_transactions")).rows
    ).toEqual([{ custody_wallet_id: null }]);

    await client.query(`INSERT INTO issued_tokens
      (id, organization_id, project_id, signing_custody_wallet_id,
       signing_wallet_id, mint_address, status) VALUES
      ('tok_straggler', 'org_a', 'prj_a', NULL, 'provider_project', NULL, 'pending'),
      ('tok_mismatched', 'org_a', 'prj_a', 'cw_foreign', 'provider_project', 'mint_mismatch', 'active'),
      ('tok_rollback_safe', 'org_a', 'prj_a', 'cw_project_shadow', 'provider_shadow', NULL, 'pending'),
      ('tok_rollback_shadowed', 'org_a', 'prj_a', 'cw_org_shadow', 'provider_shadow', NULL, 'pending'),
      ('tok_deploying', 'org_a', 'prj_a', 'cw_project', 'provider_project', NULL, 'deploying')`);
    await client.query(`INSERT INTO issuance_transactions
      (id, token_id, organization_id, custody_wallet_id, type, status) VALUES
      ('ttx_missing_pending', 'tok_deployed', 'org_a', NULL, 'mint', 'pending'),
      ('ttx_missing_processing', 'tok_deployed', 'org_a', NULL, 'burn', 'processing'),
      ('ttx_legacy_failed', 'tok_deployed', 'org_a', NULL, 'mint', 'failed'),
      ('ttx_wrong_wallet', 'tok_deployed', 'org_a', 'cw_foreign', 'mint', 'confirmed'),
      ('ttx_wrong_org', 'tok_deployed', 'org_b', 'cw_project', 'mint', 'confirmed'),
      ('ttx_exact_processing', 'tok_deployed', 'org_a', 'cw_project', 'burn', 'processing'),
      ('ttx_exact', 'tok_deployed', 'org_a', 'cw_project', 'mint', 'confirmed')`);
    await client.query(`INSERT INTO wallet_operations
      (id, organization_id, project_id, operation_type, status, custody_wallet_id) VALUES
      ('op_pending', 'org_a', 'prj_a', 'issuance_mint_execute', 'pending_approval', 'cw_project'),
      ('op_executing', 'org_a', 'prj_a', 'issuance_update_authority_execute', 'executing', 'cw_project'),
      ('op_completed', 'org_a', 'prj_a', 'issuance_mint_execute', 'completed', 'cw_project'),
      ('op_other', 'org_a', 'prj_a', 'payment_transfer_execute', 'pending_approval', 'cw_project')`);

    const auditSql = readFileSync(auditPath, "utf8");
    await client.query(withoutPsqlCommands(auditSql));

    expect((await client.query(auditSection(auditSql, "1a.", "1b."))).rows).toEqual([
      {
        id: "tok_straggler",
        organization_id: "org_a",
        project_id: "prj_a",
        signing_wallet_id: "provider_project",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "1b.", "2."))).rows).toEqual([
      {
        id: "tok_ambiguous",
        match_count: 2,
        organization_id: "org_a",
        project_id: "prj_a",
        signing_wallet_id: "provider_duplicate",
      },
      {
        id: "tok_unresolved",
        match_count: 0,
        organization_id: "org_a",
        project_id: "prj_a",
        signing_wallet_id: "provider_missing",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "2.", "2a."))).rows).toEqual([
      {
        id: "tok_mismatched",
        organization_id: "org_a",
        project_id: "prj_a",
        signing_custody_wallet_id: "cw_foreign",
        signing_wallet_id: "provider_project",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "2a.", "3."))).rows).toEqual([
      {
        id: "tok_connection",
        legacy_custody_wallet_id: null,
        organization_id: "org_a",
        project_id: "prj_a",
        signing_custody_wallet_id: "cw_connection",
        signing_wallet_id: "provider_connection",
      },
      {
        id: "tok_rollback_shadowed",
        legacy_custody_wallet_id: "cw_project_shadow",
        organization_id: "org_a",
        project_id: "prj_a",
        signing_custody_wallet_id: "cw_org_shadow",
        signing_wallet_id: "provider_shadow",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "3.", "4."))).rows).toEqual([
      {
        created_at: "2026-01-01T00:00:00.000Z",
        custody_wallet_id: "cw_project",
        id: "ttx_exact_processing",
        organization_id: "org_a",
        status: "processing",
        token_id: "tok_deployed",
        type: "burn",
      },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        custody_wallet_id: null,
        id: "ttx_missing_pending",
        organization_id: "org_a",
        status: "pending",
        token_id: "tok_deployed",
        type: "mint",
      },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        custody_wallet_id: null,
        id: "ttx_missing_processing",
        organization_id: "org_a",
        status: "processing",
        token_id: "tok_deployed",
        type: "burn",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "4.", "5."))).rows).toEqual([
      {
        custody_wallet_id: "cw_foreign",
        id: "ttx_wrong_wallet",
        organization_id: "org_a",
        project_id: "prj_a",
        token_id: "tok_deployed",
        token_organization_id: "org_a",
      },
      {
        custody_wallet_id: "cw_project",
        id: "ttx_wrong_org",
        organization_id: "org_b",
        project_id: "prj_a",
        token_id: "tok_deployed",
        token_organization_id: "org_a",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "5.", "6."))).rows).toEqual([
      {
        id: "tok_deploying",
        organization_id: "org_a",
        project_id: "prj_a",
        signing_custody_wallet_id: "cw_project",
        updated_at: "2026-01-01T00:00:00.000Z",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "6.", "7."))).rows).toEqual([
      {
        created_at: "2026-01-01T00:00:00.000Z",
        custody_wallet_id: "cw_project",
        id: "op_executing",
        operation_type: "issuance_update_authority_execute",
        organization_id: "org_a",
        project_id: "prj_a",
        status: "executing",
      },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        custody_wallet_id: "cw_project",
        id: "op_pending",
        operation_type: "issuance_mint_execute",
        organization_id: "org_a",
        project_id: "prj_a",
        status: "pending_approval",
      },
    ]);
    expect((await client.query(auditSection(auditSql, "7."))).rows).toEqual([
      {
        created_at: "2026-01-01T00:00:00.000Z",
        id: "ttx_legacy",
        organization_id: "org_a",
        status: "confirmed",
        token_id: "tok_deployed",
        type: "mint",
      },
      {
        created_at: "2026-01-01T00:00:00.000Z",
        id: "ttx_legacy_failed",
        organization_id: "org_a",
        status: "failed",
        token_id: "tok_deployed",
        type: "mint",
      },
    ]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
