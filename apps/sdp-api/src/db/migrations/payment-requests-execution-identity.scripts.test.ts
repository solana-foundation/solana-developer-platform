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

function auditSection(prefix: string): string {
  const sql = readFileSync(
    path.join(scriptsDirectory, "audit-payments-execution-identity.sql"),
    "utf8"
  );
  const section = sql.indexOf(`\\echo '=== ${prefix}`);
  if (section < 0) throw new Error(`Missing audit section ${prefix}`);
  const start = sql.indexOf("\n", section) + 1;
  const end = sql.indexOf("\\echo", start);
  return sql.slice(start, end < 0 ? undefined : end);
}

it("audits unresolved Request recipients using current expiry and money admission", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE projects (
      id TEXT PRIMARY KEY, organization_id TEXT, environment TEXT, status TEXT DEFAULT 'active'
    )`);
    await client.query(`CREATE TEMP TABLE organizations (
      id TEXT PRIMARY KEY, status TEXT, settings TEXT
    )`);
    await client.query(`INSERT INTO projects (id, organization_id, environment) VALUES
      ('prj_a', 'org_a', 'sandbox'),
      ('prj_prod', 'org_a', 'production'),
      ('prj_enabled', 'org_enabled', 'production'),
      ('prj_suspended', 'org_suspended', 'sandbox'),
      ('prj_deleted', 'org_deleted', 'sandbox')`);
    await client.query(
      `INSERT INTO projects VALUES ('prj_archived', 'org_a', 'sandbox', 'archived')`
    );
    await client.query(`INSERT INTO organizations VALUES
      ('org_a', 'active', '{}'),
      ('org_enabled', 'active', '{"enableProductionProject":true}'),
      ('org_suspended', 'suspended', '{}'),
      ('org_deleted', 'deleted', '{}')`);
    await client.query(`CREATE TEMP TABLE payment_requests (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
      status TEXT NOT NULL, custody_wallet_id TEXT, expires_at TEXT
    )`);
    await client.query(`INSERT INTO payment_requests VALUES
      ('open', 'org_a', 'prj_a', 'awaiting_payment', NULL, NULL),
      ('future', 'org_a', 'prj_a', 'awaiting_payment', NULL, '2999-01-01T00:00:00.000Z'),
      ('expired', 'org_a', 'prj_a', 'awaiting_payment', NULL, '2000-01-01T00:00:00.000Z'),
      ('archived_project', 'org_a', 'prj_archived', 'awaiting_payment', NULL, NULL),
      ('no_project', 'org_a', NULL, 'awaiting_payment', NULL, NULL),
      ('production_disabled', 'org_a', 'prj_prod', 'awaiting_payment', NULL, NULL),
      ('production_enabled', 'org_enabled', 'prj_enabled', 'awaiting_payment', NULL, NULL),
      ('foreign_project', 'org_a', 'prj_enabled', 'awaiting_payment', NULL, NULL),
      ('suspended', 'org_suspended', 'prj_suspended', 'awaiting_payment', NULL, NULL),
      ('deleted', 'org_deleted', 'prj_deleted', 'awaiting_payment', NULL, NULL),
      ('pinned', 'org_a', 'prj_a', 'awaiting_payment', 'cw_a', NULL),
      ('paid', 'org_a', 'prj_a', 'paid', NULL, NULL),
      ('canceled', 'org_a', 'prj_a', 'canceled', NULL, NULL)`);

    const before = (await client.query("SELECT * FROM payment_requests ORDER BY id")).rows;
    const result = await client.query<{ id: string }>(auditSection("2b."));
    expect(result.rows.map((row) => row.id)).toEqual(["future", "open", "production_enabled"]);
    expect((await client.query("SELECT * FROM payment_requests ORDER BY id")).rows).toEqual(before);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("audits every retained Request window independently of parent lifecycle without printing bearer bytes", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE payment_requests (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT,
      status TEXT NOT NULL, custody_wallet_id TEXT, expires_at TEXT,
      sponsored_tx_account TEXT, sponsored_tx_unsigned TEXT, sponsored_tx_signed TEXT,
      sponsored_tx_last_valid_block_height BIGINT, sponsored_tx_continuity JSONB
    )`);
    await client.query(`INSERT INTO payment_requests VALUES
      ('canceled_signed', 'org_a', 'prj_a', 'canceled', NULL, '2000-01-01',
       'payer', 'unsigned', 'signed', 1, NULL),
      ('expired_unsigned', 'org_a', 'prj_a', 'awaiting_payment', 'cw_a', '2000-01-01',
       'payer', 'unsigned', NULL, 1, NULL),
      ('paid_unsigned', 'org_a', 'prj_a', 'paid', 'cw_a', NULL,
       'payer', 'unsigned', NULL, 1, NULL),
      ('malformed', 'org_a', 'prj_a', 'paid', 'cw_a', NULL,
       NULL, 'unsigned', NULL, 1, NULL),
      ('stale_projection', 'org_a', 'prj_a', 'paid', 'cw_a', NULL,
       'payer', 'unsigned', NULL, 1,
       '{"account":"other-payer","unsignedTransaction":"old-unsigned","lastValidBlockHeight":"0","deploymentMode":"managed","accountingIdentity":{"reservationId":"sbr_old"}}'),
      ('no_claim', 'org_a', 'prj_a', 'awaiting_payment', NULL, NULL,
       NULL, NULL, NULL, NULL, NULL)`);
    const before = (await client.query("SELECT * FROM payment_requests ORDER BY id")).rows;
    const result = await client.query<{ id: string; classification: string }>(auditSection("2c."));
    expect(result.rows.map(({ id, classification }) => ({ id, classification }))).toEqual([
      { id: "canceled_signed", classification: "signed_claim_review" },
      { id: "expired_unsigned", classification: "unsigned_claim_review" },
      { id: "malformed", classification: "invalid_claim_shape" },
      { id: "paid_unsigned", classification: "unsigned_claim_review" },
      { id: "stale_projection", classification: "stale_continuity_projection" },
    ]);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("sponsored_tx_unsigned");
      expect(row).not.toHaveProperty("sponsored_tx_signed");
      expect(row).not.toHaveProperty("sponsored_tx_continuity");
    }
    expect((await client.query("SELECT * FROM payment_requests ORDER BY id")).rows).toEqual(before);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("audits outstanding accounting even after its Request slot was replaced without guessing ownership", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE sponsorship_budget_reservations (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT,
      actor_type TEXT, actor_id TEXT, product_environment TEXT, network TEXT,
      status TEXT, attempt INTEGER, redis_settled_at TEXT,
      signed_transaction TEXT, signature TEXT, reserved_lamports BIGINT,
      actual_lamports BIGINT, created_at TEXT, updated_at TEXT,
      provider_config_fingerprint TEXT, transaction_digest TEXT
    )`);
    await client.query(`INSERT INTO sponsorship_budget_reservations
      SELECT id, 'org_a', 'prj_a', 'wallet', 'shared-provider-reference', 'sandbox', 'devnet',
             status, 3, settled_at, signed_bytes, signature, 100, 90,
             '2000-01-01', '2000-01-01', 'original-provider-config', id || '-digest'
      FROM (VALUES
        ('unknown', 'charged_unknown', NULL, NULL, NULL),
        ('signed', 'signed', NULL, 'original-signed', 'original-signature'),
        ('orphan', 'reserved', NULL, NULL, NULL),
        ('submitted', 'submitted', NULL, 'submitted-bytes', 'submitted-signature'),
        ('committed_unsettled', 'committed', NULL, 'settled-bytes', 'settled-signature'),
        ('released_unsettled', 'released', NULL, NULL, NULL),
        ('committed_settled', 'committed', '2000-01-02', 'settled-bytes', 'settled-signature'),
        ('released_settled', 'released', '2000-01-02', NULL, NULL),
        ('unexpected', 'unrecognized', '2000-01-02', NULL, NULL),
        ('missing_state', NULL, '2000-01-02', NULL, NULL)
      ) AS fixture(id, status, settled_at, signed_bytes, signature)`);
    const before = (await client.query("SELECT * FROM sponsorship_budget_reservations ORDER BY id"))
      .rows;
    const result = await client.query<{ id: string; classification: string }>(auditSection("2d."));
    expect(result.rows.map(({ id, classification }) => ({ id, classification }))).toEqual([
      { id: "committed_unsettled", classification: "redis_settlement_pending" },
      { id: "missing_state", classification: "unknown_accounting_state" },
      { id: "orphan", classification: "in_progress_or_pre_admission" },
      { id: "released_unsettled", classification: "redis_settlement_pending" },
      { id: "signed", classification: "provider_effect_evidence" },
      { id: "submitted", classification: "provider_effect_evidence" },
      { id: "unexpected", classification: "unknown_accounting_state" },
      { id: "unknown", classification: "charged_unknown" },
    ]);
    for (const row of result.rows) {
      expect(row).not.toHaveProperty("signed_transaction");
      expect(row).not.toHaveProperty("referencing_request_ids");
    }
    expect(
      (await client.query("SELECT * FROM sponsorship_budget_reservations ORDER BY id")).rows
    ).toEqual(before);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("backfills only one retained scoped recipient without changing Request or accounting evidence", async () => {
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT NOT NULL, status TEXT
    )`);
    await client.query(`CREATE TEMP TABLE custody_connections (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT NOT NULL, status TEXT
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY, custody_config_id TEXT, custody_connection_id TEXT,
      wallet_id TEXT, public_key TEXT, status TEXT
    )`);
    await client.query(`CREATE TEMP TABLE payment_transfers (
      id TEXT, organization_id TEXT, project_id TEXT, wallet_id TEXT,
      direction TEXT, source_address TEXT, destination_address TEXT, custody_wallet_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE payment_transfer_batches (
      id TEXT, organization_id TEXT, project_id TEXT, source_wallet_id TEXT,
      source_address TEXT, source_custody_wallet_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE payment_requests (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT,
      wallet_id TEXT, destination_address TEXT, custody_wallet_id TEXT,
      public_token TEXT, reference TEXT, token TEXT, amount TEXT, status TEXT,
      fulfilled_by_transfer_id TEXT, lifecycle JSONB, sponsored_tx_account TEXT,
      sponsored_tx_unsigned TEXT, sponsored_tx_signed TEXT,
      sponsored_tx_last_valid_block_height BIGINT, sponsored_tx_continuity JSONB
    )`);
    await client.query(`CREATE TEMP TABLE sponsorship_budget_reservations (
      id TEXT PRIMARY KEY, status TEXT, attempt INTEGER
    )`);
    await client.query(`INSERT INTO custody_configs VALUES
      ('cfg_a', 'org_a', 'prj_a', 'archived'),
      ('cfg_b', 'org_a', 'prj_b', 'inactive'),
      ('cfg_moved', 'org_a', 'prj_sandbox', 'active'),
      ('cfg_other_org', 'org_b', 'prj_a', 'active')`);
    await client.query(`INSERT INTO custody_connections VALUES
      ('conn_a', 'org_a', 'prj_a', 'archived')`);
    await client.query(`INSERT INTO custody_wallets VALUES
      ('cw_unique', 'cfg_a', NULL, 'provider_unique', 'address_unique', 'inactive'),
      ('cw_other_scope', 'cfg_b', NULL, 'provider_unique', 'address_unique', 'active'),
      ('cw_other_org', 'cfg_other_org', NULL, 'provider_unique', 'address_unique', 'active'),
      ('cw_moved', 'cfg_moved', NULL, 'provider_moved', 'address_moved', 'active'),
      ('cw_a', 'cfg_a', NULL, 'provider_duplicate', 'address_duplicate', 'active'),
      ('cw_conn_duplicate', NULL, 'conn_a', 'provider_duplicate', 'address_duplicate', 'inactive'),
      ('cw_conn', NULL, 'conn_a', 'provider_connection', 'address_connection', 'inactive')`);
    await client.query(`INSERT INTO payment_requests
      (id, organization_id, project_id, wallet_id, destination_address, custody_wallet_id,
       public_token, reference, token, amount, status, fulfilled_by_transfer_id, lifecycle,
       sponsored_tx_account, sponsored_tx_unsigned, sponsored_tx_signed,
       sponsored_tx_last_valid_block_height, sponsored_tx_continuity)
      SELECT fixture.id, 'org_a', 'prj_a', fixture.wallet_id, fixture.address, fixture.pin,
             fixture.id || '-token', fixture.id || '-reference', 'SOL', '1.5', fixture.status,
             CASE WHEN fixture.status = 'paid' THEN 'xfr_original' END,
             '[{"status":"awaiting_payment","at":"2000-01-01"}]'::JSONB,
             'payer', 'unsigned-original', 'signed-original', 1,
             '{"account":"payer","accountingIdentity":{"reservationId":"sbr_original"}}'::JSONB
      FROM (VALUES
        ('unique', 'provider_unique', 'address_unique', NULL, 'awaiting_payment'),
        ('connection', 'provider_connection', 'address_connection', NULL, 'awaiting_payment'),
        ('ambiguous', 'provider_duplicate', 'address_duplicate', NULL, 'awaiting_payment'),
        ('missing', 'provider_missing', 'address_missing', NULL, 'awaiting_payment'),
        ('address_mismatch', 'provider_unique', 'wrong_address', NULL, 'awaiting_payment'),
        ('moved_config', 'provider_moved', 'address_moved', NULL, 'awaiting_payment'),
        ('pinned', 'provider_duplicate', 'address_duplicate', 'cw_a', 'awaiting_payment'),
        ('terminal', 'provider_duplicate', 'address_duplicate', NULL, 'paid')
      ) AS fixture(id, wallet_id, address, pin, status)`);
    await client.query(
      "INSERT INTO sponsorship_budget_reservations VALUES ('sbr_original', 'charged_unknown', 3)"
    );
    const evidence = async () => ({
      requests: (
        await client.query(`SELECT to_jsonb(request) - 'custody_wallet_id' AS evidence
        FROM payment_requests request ORDER BY id`)
      ).rows,
      reservations: (
        await client.query("SELECT * FROM sponsorship_budget_reservations ORDER BY id")
      ).rows,
    });
    const before = await evidence();
    const sql = readFileSync(
      path.join(scriptsDirectory, "backfill-payments-execution-identity.sql"),
      "utf8"
    );
    const start = sql.indexOf("BEGIN;") + "BEGIN;".length;
    const end = sql.indexOf("COMMIT;", start);
    if (start < "BEGIN;".length || end < start) throw new Error("Missing catch-up transaction");
    await client.query(sql.slice(start, end));
    await client.query(sql.slice(start, end));

    expect(
      (await client.query("SELECT id, custody_wallet_id FROM payment_requests ORDER BY id")).rows
    ).toEqual([
      { id: "address_mismatch", custody_wallet_id: null },
      { id: "ambiguous", custody_wallet_id: null },
      { id: "connection", custody_wallet_id: "cw_conn" },
      { id: "missing", custody_wallet_id: null },
      { id: "moved_config", custody_wallet_id: null },
      { id: "pinned", custody_wallet_id: "cw_a" },
      { id: "terminal", custody_wallet_id: null },
      { id: "unique", custody_wallet_id: "cw_unique" },
    ]);
    expect(await evidence()).toEqual(before);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
