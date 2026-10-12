import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const scriptsDirectory = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts"
);
const auditSql = readFileSync(
  path.join(scriptsDirectory, "audit-payments-execution-identity.sql"),
  "utf8"
);

function auditSection(section: string, nextSection?: string): string {
  const marker = auditSql.indexOf(`\\echo '=== ${section}`);
  const start = marker === -1 ? -1 : auditSql.indexOf("\n", marker) + 1;
  const end = nextSection ? auditSql.indexOf(`\\echo '=== ${nextSection}`, start) : auditSql.length;
  if (start <= 0 || end === -1) throw new Error(`audit section ${section} is missing`);
  return auditSql.slice(start, end);
}

async function createTables(client: Client): Promise<void> {
  await client.query(`CREATE TEMP TABLE custody_configs (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TEMP TABLE custody_connections (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TEMP TABLE custody_wallets (
    id TEXT PRIMARY KEY, custody_config_id TEXT, custody_connection_id TEXT,
    wallet_id TEXT NOT NULL, public_key TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active'
  );
  CREATE TEMP TABLE payment_transfers (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL DEFAULT 'org_a',
    project_id TEXT NOT NULL DEFAULT 'prj_a', custody_wallet_id TEXT,
    wallet_id TEXT NOT NULL DEFAULT 'provider_a', source_address TEXT DEFAULT 'address_a',
    destination_address TEXT DEFAULT 'destination', direction TEXT NOT NULL DEFAULT 'outbound',
    type TEXT NOT NULL DEFAULT 'transfer', status TEXT NOT NULL DEFAULT 'processing',
    signature TEXT, signed_transaction TEXT, last_valid_block_height NUMERIC,
    submission_started_at TEXT, provider TEXT, provider_reference TEXT,
    provider_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    idempotency_key TEXT DEFAULT 'original-intent', idempotency_fingerprint TEXT DEFAULT 'original-fingerprint',
    created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
    updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
  );
  CREATE TEMP TABLE payment_transfer_batches (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL DEFAULT 'org_a',
    project_id TEXT NOT NULL DEFAULT 'prj_a', source_custody_wallet_id TEXT,
    source_wallet_id TEXT NOT NULL DEFAULT 'provider_a', source_address TEXT NOT NULL DEFAULT 'address_a',
    status TEXT NOT NULL DEFAULT 'processing', idempotency_key TEXT DEFAULT 'batch-intent',
    idempotency_fingerprint TEXT DEFAULT 'batch-fingerprint',
    created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
  );
  CREATE TEMP TABLE payment_transfer_recipients (
    id TEXT PRIMARY KEY, batch_id TEXT NOT NULL, organization_id TEXT NOT NULL DEFAULT 'org_a',
    project_id TEXT NOT NULL DEFAULT 'prj_a', transfer_id TEXT, status TEXT NOT NULL DEFAULT 'pending'
  );
  CREATE TEMP TABLE payment_requests (
    id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL,
    custody_wallet_id TEXT, wallet_id TEXT NOT NULL, destination_address TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_payment'
  );`);
}

it("audits unresolved transfer, batch and ramp work with retained submission evidence", async () => {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await createTables(client);
    await client.query(`INSERT INTO payment_transfers
      (id, type, direction, status, signature, signed_transaction, last_valid_block_height,
       submission_started_at, provider, provider_reference, provider_data) VALUES
      ('transfer_pending', 'transfer', 'outbound', 'pending', NULL, NULL, NULL, NULL, NULL, NULL, '{}'),
      ('transfer_unknown', 'transfer', 'outbound', 'failed', 'sig_original', 'bytes_original', 123,
       '2026-01-01T01:00:00.000Z', NULL, NULL, '{}'),
      ('transfer_finalized', 'transfer', 'outbound', 'finalized', 'sig_final', 'bytes_final', 123,
       '2026-01-01T01:00:00.000Z', NULL, NULL, '{}'),
      ('ramp_awaiting', 'offramp', 'outbound', 'awaiting_payment', NULL, NULL, NULL, NULL,
       'moneygram', 'native_quote', '{"rampQuote":{"expiresAt":"2999-01-01T00:00:00.000Z"}}'),
      ('ramp_finalized', 'onramp', 'inbound', 'finalized', NULL, NULL, NULL, NULL,
       'moneygram', 'unfinished_native_reference', '{}'),
      ('ramp_unknown', 'offramp', 'outbound', 'canceled', NULL, NULL, NULL, NULL,
       'moneygram', 'native_session', '{"moneygram":{"cryptoTransferId":"transfer_unknown"}}');
      INSERT INTO payment_transfer_batches (id, status) VALUES
      ('batch_pending', 'processing'), ('batch_failed', 'failed');
      INSERT INTO payment_transfer_recipients (id, batch_id, transfer_id) VALUES
      ('recipient_pending', 'batch_pending', 'transfer_pending'),
      ('recipient_unknown', 'batch_failed', 'transfer_unknown');`);

    expect((await client.query(auditSection("3.", "4."))).rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resource: "transfer", id: "transfer_pending" }),
        expect.objectContaining({ resource: "ramp", id: "ramp_awaiting" }),
        expect.objectContaining({ resource: "batch", id: "batch_pending" }),
        expect.objectContaining({ resource: "batch", id: "batch_failed" }),
      ])
    );
    const effects = (await client.query(auditSection("4.", "5."))).rows;
    expect(effects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "transfer_unknown",
          signature: "sig_original",
          has_signed_transaction: true,
          submission_started_at: "2026-01-01T01:00:00.000Z",
        }),
        expect.objectContaining({
          id: "ramp_unknown",
          provider_reference: "native_session",
          crypto_transfer_id: "transfer_unknown",
        }),
        expect.objectContaining({
          id: "ramp_finalized",
          provider_reference: "unfinished_native_reference",
        }),
      ])
    );
    expect(effects.map((row) => row.id)).not.toContain("transfer_finalized");
    await client.query(
      auditSql
        .split("\n")
        .filter((line) => !line.startsWith("\\"))
        .join("\n")
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("audits MoneyGram links by two non-null exact pins and the original project scope", async () => {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await createTables(client);
    await client.query(`INSERT INTO payment_transfers (id, custody_wallet_id, organization_id) VALUES
      ('leg_a', 'cw_a', 'org_a'), ('leg_b', 'cw_b', 'org_a'),
      ('leg_null', NULL, 'org_a'), ('leg_foreign', 'cw_a', 'org_b');
      INSERT INTO payment_transfers (id, custody_wallet_id, type, provider, provider_data) VALUES
      ('ramp_same', 'cw_a', 'offramp', 'moneygram', '{"moneygram":{"cryptoTransferId":"leg_a"}}'),
      ('ramp_different', 'cw_a', 'offramp', 'moneygram', '{"moneygram":{"cryptoTransferId":"leg_b"}}'),
      ('ramp_null', NULL, 'offramp', 'moneygram', '{"moneygram":{"cryptoTransferId":"leg_a"}}'),
      ('ramp_null_leg', 'cw_a', 'offramp', 'moneygram', '{"moneygram":{"cryptoTransferId":"leg_null"}}'),
      ('ramp_both_null', NULL, 'offramp', 'moneygram', '{"moneygram":{"cryptoTransferId":"leg_null"}}'),
      ('ramp_foreign', 'cw_a', 'offramp', 'moneygram', '{"moneygram":{"cryptoTransferId":"leg_foreign"}}'),
      ('ramp_missing', 'cw_a', 'offramp', 'moneygram', '{"moneygram":{"cryptoTransferId":"leg_missing"}}');`);
    const rows = (await client.query(auditSection("5."))).rows;
    expect(rows.map((row) => row.ramp_id)).toEqual([
      "ramp_both_null",
      "ramp_different",
      "ramp_foreign",
      "ramp_missing",
      "ramp_null",
      "ramp_null_leg",
    ]);
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ramp_id: "ramp_different",
          ramp_custody_wallet_id: "cw_a",
          crypto_custody_wallet_id: "cw_b",
        }),
        expect.objectContaining({ ramp_id: "ramp_foreign", crypto_custody_wallet_id: null }),
      ])
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});

it("backfills only unique scoped null pins, including retained ramp wallets, without rewriting evidence", async () => {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await createTables(client);
    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id, status) VALUES
      ('cfg_active', 'org_a', 'prj_a', 'active'), ('cfg_archived', 'org_a', 'prj_a', 'archived'),
      ('cfg_foreign', 'org_a', 'prj_b', 'active'), ('cfg_other_org', 'org_b', 'prj_a', 'active');
      INSERT INTO custody_connections (id, organization_id, project_id) VALUES
      ('conn_active', 'org_a', 'prj_a');
      INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key, status) VALUES
      ('cw_a', 'cfg_active', NULL, 'provider_a', 'address_a', 'active'),
      ('cw_inactive', 'cfg_archived', NULL, 'provider_inactive', 'address_inactive', 'inactive'),
      ('cw_connection', NULL, 'conn_active', 'provider_connection', 'address_connection', 'active'),
      ('cw_shared_active', 'cfg_active', NULL, 'provider_shared', 'address_shared', 'active'),
      ('cw_shared_archived', 'cfg_archived', NULL, 'provider_shared', 'address_shared', 'inactive'),
      ('cw_foreign', 'cfg_foreign', NULL, 'provider_foreign', 'address_foreign', 'active'),
      ('cw_other_org', 'cfg_other_org', NULL, 'provider_other_org', 'address_other_org', 'active');
      INSERT INTO payment_transfers
      (id, custody_wallet_id, wallet_id, source_address, destination_address, direction, type, status,
       signature, signed_transaction, last_valid_block_height, submission_started_at, provider_data) VALUES
      ('unique_transfer', NULL, 'provider_a', 'address_a', 'destination', 'outbound', 'transfer', 'processing',
       'saved_signature', 'saved_bytes', 999, '2026-01-01T00:01:00.000Z', '{}'),
      ('retained_onramp', NULL, 'provider_inactive', 'external_payer', 'address_inactive', 'inbound',
       'onramp', 'awaiting_payment', NULL, NULL, NULL, NULL, '{"native":"quote_onramp"}'),
      ('connection_offramp', NULL, 'provider_connection', 'address_connection', 'deposit', 'outbound',
       'offramp', 'awaiting_payment', NULL, NULL, NULL, NULL, '{"native":"quote_offramp"}'),
      ('ambiguous_ramp', NULL, 'provider_shared', 'address_shared', 'deposit', 'outbound',
       'offramp', 'awaiting_payment', NULL, NULL, NULL, NULL, '{}'),
      ('address_mismatch', NULL, 'provider_a', 'wrong_address', 'destination', 'outbound', 'transfer', 'processing',
       NULL, NULL, NULL, NULL, '{}'),
      ('zero_match', NULL, 'provider_missing', 'address_missing', 'destination', 'outbound', 'transfer', 'processing',
       NULL, NULL, NULL, NULL, '{}'),
      ('foreign_project', NULL, 'provider_foreign', 'address_foreign', 'destination', 'outbound', 'transfer', 'processing',
       NULL, NULL, NULL, NULL, '{}'),
      ('foreign_org', NULL, 'provider_other_org', 'address_other_org', 'destination', 'outbound', 'transfer', 'processing',
       NULL, NULL, NULL, NULL, '{}'),
      ('existing_wrong_pin', 'cw_foreign', 'provider_a', 'address_a', 'destination', 'outbound', 'transfer', 'processing',
       'retained_signature', 'retained_bytes', 123, '2026-01-01T00:02:00.000Z', '{}');
      INSERT INTO payment_transfer_batches
      (id, source_custody_wallet_id, source_wallet_id, source_address) VALUES
      ('batch_unique', NULL, 'provider_connection', 'address_connection'),
      ('batch_ambiguous', NULL, 'provider_shared', 'address_shared'),
      ('batch_wrong_pin', 'cw_a', 'provider_connection', 'address_connection');
      INSERT INTO payment_transfer_recipients (id, batch_id, transfer_id) VALUES
      ('recipient_original', 'batch_unique', 'unique_transfer');`);

    expect((await client.query(auditSection("1.", "1a."))).rows).toEqual(
      expect.arrayContaining([
        {
          resource: "transfer",
          status: "awaiting_payment",
          resolvable_unique: 2,
          unresolved_zero: 0,
          ambiguous_multi: 1,
        },
        {
          resource: "transfer",
          status: "processing",
          resolvable_unique: 1,
          unresolved_zero: 4,
          ambiguous_multi: 0,
        },
      ])
    );
    const preservedSql = `SELECT * FROM (SELECT 'transfer' AS resource, to_jsonb(transfer) - 'custody_wallet_id' AS evidence
      FROM payment_transfers transfer
      UNION ALL SELECT 'batch', to_jsonb(batch) - 'source_custody_wallet_id' FROM payment_transfer_batches batch
      UNION ALL SELECT 'recipient', to_jsonb(recipient) FROM payment_transfer_recipients recipient) evidence_rows
      ORDER BY resource, evidence ->> 'id'`;
    const evidenceBefore = (await client.query(preservedSql)).rows;
    const catchUpSql = readFileSync(
      path.join(scriptsDirectory, "backfill-payments-execution-identity.sql"),
      "utf8"
    );
    const transaction = catchUpSql.slice(
      catchUpSql.indexOf("BEGIN;") + 6,
      catchUpSql.indexOf("COMMIT;")
    );
    await client.query(transaction);
    await client.query(transaction);
    expect(
      (await client.query("SELECT id, custody_wallet_id FROM payment_transfers ORDER BY id")).rows
    ).toEqual([
      { id: "address_mismatch", custody_wallet_id: null },
      { id: "ambiguous_ramp", custody_wallet_id: null },
      { id: "connection_offramp", custody_wallet_id: "cw_connection" },
      { id: "existing_wrong_pin", custody_wallet_id: "cw_foreign" },
      { id: "foreign_org", custody_wallet_id: null },
      { id: "foreign_project", custody_wallet_id: null },
      { id: "retained_onramp", custody_wallet_id: "cw_inactive" },
      { id: "unique_transfer", custody_wallet_id: "cw_a" },
      { id: "zero_match", custody_wallet_id: null },
    ]);
    expect(
      (
        await client.query(
          "SELECT id, source_custody_wallet_id FROM payment_transfer_batches ORDER BY id"
        )
      ).rows
    ).toEqual([
      { id: "batch_ambiguous", source_custody_wallet_id: null },
      { id: "batch_unique", source_custody_wallet_id: "cw_connection" },
      { id: "batch_wrong_pin", source_custody_wallet_id: "cw_a" },
    ]);
    expect((await client.query(preservedSql)).rows).toEqual(evidenceBefore);
    expect((await client.query(auditSection("2.", "2a."))).rows).toEqual([
      { resource: "batch", id: "batch_wrong_pin", custody_wallet_id: "cw_a" },
      { resource: "transfer", id: "existing_wrong_pin", custody_wallet_id: "cw_foreign" },
    ]);
    expect((await client.query(auditSection("2a.", "2b."))).rows).toEqual([
      expect.objectContaining({
        batch_id: "batch_unique",
        transfer_id: "unique_transfer",
        batch_custody_wallet_id: "cw_connection",
        transfer_custody_wallet_id: "cw_a",
        signature: "saved_signature",
        has_signed_transaction: true,
        submission_started_at: "2026-01-01T00:01:00.000Z",
      }),
    ]);
    await client.query(`INSERT INTO payment_transfers (id) VALUES ('late_writer');`);
    await client.query(transaction);
    expect(
      (
        await client.query(
          "SELECT custody_wallet_id FROM payment_transfers WHERE id = 'late_writer'"
        )
      ).rows
    ).toEqual([{ custody_wallet_id: "cw_a" }]);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
