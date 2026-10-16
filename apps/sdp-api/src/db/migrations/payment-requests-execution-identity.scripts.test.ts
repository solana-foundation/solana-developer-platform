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
      sponsored_tx_last_valid_block_height BIGINT
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
       sponsored_tx_last_valid_block_height)
      SELECT fixture.id, 'org_a', 'prj_a', fixture.wallet_id, fixture.address, fixture.pin,
             fixture.id || '-token', fixture.id || '-reference', 'SOL', '1.5', fixture.status,
             CASE WHEN fixture.status = 'paid' THEN 'xfr_original' END,
             '[{"status":"awaiting_payment","at":"2000-01-01"}]'::JSONB,
             'payer', 'unsigned-original', 'signed-original', 1
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
