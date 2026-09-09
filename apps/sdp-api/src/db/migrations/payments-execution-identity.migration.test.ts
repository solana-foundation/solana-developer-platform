import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0068_payments_execution_identity.sql"
);
const catchUpPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/backfill-payments-execution-identity.sql"
);
const auditPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../scripts/audit-payments-execution-identity.sql"
);

function catchUpTransaction(sql: string): string {
  const start = sql.indexOf("BEGIN;");
  const end = sql.indexOf("COMMIT;", start);
  if (start === -1 || end === -1) throw new Error("catch-up transaction is missing");
  return sql.slice(start + "BEGIN;".length, end);
}

function withoutPsqlCommands(sql: string): string {
  return sql
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
}

it("pins only exactly-one Payments identities without mutating live work", async () => {
  const sql = readFileSync(migrationPath, "utf8");
  const client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE custody_connections (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY,
      custody_config_id TEXT,
      custody_connection_id TEXT,
      wallet_id TEXT NOT NULL,
      public_key TEXT NOT NULL
    )`);
    await client.query(`CREATE TEMP TABLE payment_transfers (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      wallet_id TEXT NOT NULL,
      source_address TEXT,
      destination_address TEXT,
      direction TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_transfer_batches (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      source_wallet_id TEXT NOT NULL,
      source_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'processing',
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      wallet_id TEXT NOT NULL,
      destination_address TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'awaiting_payment',
      canceled_by TEXT,
      lifecycle JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE payment_transfer_recipients (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      transfer_id TEXT
    )`);
    await client.query(`CREATE TEMP TABLE wallet_operations (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE SET NULL,
      wallet_id TEXT NOT NULL,
      operation_type TEXT NOT NULL,
      raw_payload JSONB NOT NULL,
      status TEXT NOT NULL,
      execution_attempt_id TEXT,
      execution_lease_expires_at TEXT,
      execution_effect_started_at TEXT,
      execution_completed_at TEXT,
      execution_error TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);
    await client.query(`CREATE TEMP TABLE approval_requests (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      project_id TEXT,
      wallet_operation_id TEXT NOT NULL REFERENCES wallet_operations(id),
      status TEXT NOT NULL,
      resolved_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    )`);

    await client.query(`INSERT INTO custody_configs (id, organization_id, project_id) VALUES
      ('cfg_project', 'org_a', 'prj_a'),
      ('cfg_org', 'org_a', NULL),
      ('cfg_duplicate', 'org_a', 'prj_a'),
      ('cfg_foreign', 'org_a', 'prj_b')`);
    await client.query(`INSERT INTO custody_connections (id, organization_id, project_id) VALUES
      ('conn_project', 'org_a', 'prj_a'),
      ('conn_org', 'org_a', NULL)`);
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, custody_connection_id, wallet_id, public_key) VALUES
      ('cw_project', 'cfg_project', NULL, 'provider_project', 'addr_project'),
      ('cw_org', 'cfg_org', NULL, 'provider_org', 'addr_org'),
      ('cw_connection', NULL, 'conn_project', 'provider_connection', 'addr_connection'),
      ('cw_duplicate_a', 'cfg_project', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_duplicate_b', 'cfg_duplicate', NULL, 'provider_duplicate', 'addr_duplicate'),
      ('cw_foreign', 'cfg_foreign', NULL, 'provider_foreign', 'addr_foreign'),
      ('cw_org_connection', NULL, 'conn_org', 'provider_org_connection', 'addr_org_connection')`);

    await client.query(`INSERT INTO payment_transfers
      (id, organization_id, project_id, wallet_id, source_address, destination_address, direction) VALUES
      ('xfr_outbound', 'org_a', 'prj_a', 'provider_project', 'addr_project', 'dest', 'outbound'),
      ('xfr_inbound', 'org_a', 'prj_a', 'provider_org', 'payer', 'addr_org', 'inbound'),
      ('xfr_ambiguous', 'org_a', 'prj_a', 'provider_duplicate', 'addr_duplicate', 'dest', 'outbound'),
      ('xfr_foreign', 'org_a', 'prj_a', 'provider_foreign', 'addr_foreign', 'dest', 'outbound'),
      ('xfr_org_connection', 'org_a', NULL, 'provider_org_connection', 'addr_org_connection', 'dest', 'outbound')`);
    await client.query(`INSERT INTO payment_transfer_batches
      (id, organization_id, project_id, source_wallet_id, source_address) VALUES
      ('batch_unique', 'org_a', 'prj_a', 'provider_connection', 'addr_connection'),
      ('batch_ambiguous', 'org_a', 'prj_a', 'provider_duplicate', 'addr_duplicate')`);
    await client.query(`INSERT INTO payment_requests
      (id, organization_id, project_id, wallet_id, destination_address) VALUES
      ('request_unique', 'org_a', 'prj_a', 'provider_project', 'addr_project'),
      ('request_ambiguous', 'org_a', 'prj_a', 'provider_duplicate', 'addr_duplicate')`);
    await client.query(`INSERT INTO payment_transfer_recipients
      (id, batch_id, organization_id, project_id, transfer_id) VALUES
      ('recipient_mismatch', 'batch_unique', 'org_a', 'prj_a', 'xfr_outbound'),
      ('recipient_both_null', 'batch_ambiguous', 'org_a', 'prj_a', 'xfr_ambiguous')`);

    const legacyEnvelope = (source: string, path = "/v1/payments/transfers") =>
      JSON.stringify({
        source,
        context: { sourceAddress: source.replace("provider", "addr") },
        executionRequest: {
          method: "POST",
          path,
          body: { source, destination: "dest" },
          idempotencyKey: `idem-${source}`,
        },
      });
    const exactEnvelope = (
      custodyWalletId: string,
      sourceAddress: string,
      path = "/v1/payments/transfers"
    ) =>
      JSON.stringify({
        sourceCustodyWalletId: custodyWalletId,
        context: { sourceAddress },
        executionRequest: {
          method: "POST",
          path,
          body: { sourceCustodyWalletId: custodyWalletId, destination: "dest" },
          idempotencyKey: `idem-${custodyWalletId}`,
        },
      });
    await client.query(
      `INSERT INTO wallet_operations
        (id, organization_id, project_id, custody_wallet_id, wallet_id, operation_type,
         raw_payload, status, execution_lease_expires_at, execution_effect_started_at)
       VALUES
        ('op_pinned', 'org_a', 'prj_a', 'cw_project', 'provider_project',
         'payment_transfer_execute', $1, 'pending_approval', NULL, NULL),
        ('op_unique', 'org_a', 'prj_a', NULL, 'provider_connection',
         'payment_transfer_execute', $2, 'pending_approval', NULL, NULL),
        ('op_ambiguous', 'org_a', 'prj_a', NULL, 'provider_duplicate',
         'payment_transfer_execute', $3, 'pending_approval', NULL, NULL),
        ('op_stale_pre_effect', 'org_a', 'prj_a', NULL, 'provider_foreign',
         'payment_transfer_execute', $4, 'executing', '2000-01-01T00:00:00.000Z', NULL),
        ('op_live', 'org_a', 'prj_a', NULL, 'provider_connection',
         'payment_transfer_execute', $2, 'executing', '2999-01-01T00:00:00.000Z', NULL),
        ('op_post_effect', 'org_a', 'prj_a', NULL, 'provider_foreign',
         'payment_transfer_execute', $4, 'executing', '2000-01-01T00:00:00.000Z',
         '2026-01-01T00:00:00.000Z'),
        ('op_exact_unpinned', 'org_a', 'prj_a', NULL, 'provider_connection',
         'payment_transfer_execute', $5, 'pending_approval', NULL, NULL),
        ('op_malformed_exact', 'org_a', 'prj_a', NULL, 'provider_connection',
         'payment_transfer_execute', $6, 'pending_approval', NULL, NULL),
        ('op_pending_post_effect', 'org_a', 'prj_a', NULL, 'provider_duplicate',
         'payment_transfer_execute', $3, 'pending_approval', NULL,
         '2026-01-01T00:00:00.000Z')`,
      [
        legacyEnvelope("provider_project"),
        legacyEnvelope("provider_connection"),
        legacyEnvelope("provider_duplicate"),
        legacyEnvelope("provider_foreign"),
        exactEnvelope("cw_connection", "addr_connection"),
        JSON.stringify({
          sourceCustodyWalletId: "cw_connection",
          context: { sourceAddress: "addr_connection" },
          executionRequest: {
            method: "POST",
            path: "/v1/payments/transfers",
            body: { sourceCustodyWalletId: "cw_connection", destination: "dest" },
          },
        }),
      ]
    );
    await client.query(`INSERT INTO approval_requests
      (id, organization_id, project_id, wallet_operation_id, status) VALUES
      ('approval_pinned', 'org_a', 'prj_a', 'op_pinned', 'pending'),
      ('approval_unique', 'org_a', 'prj_a', 'op_unique', 'pending'),
      ('approval_ambiguous', 'org_a', 'prj_a', 'op_ambiguous', 'pending'),
      ('approval_stale', 'org_a', 'prj_a', 'op_stale_pre_effect', 'approved'),
      ('approval_live', 'org_a', 'prj_a', 'op_live', 'approved'),
      ('approval_post_effect', 'org_a', 'prj_a', 'op_post_effect', 'approved'),
      ('approval_exact_unpinned', 'org_a', 'prj_a', 'op_exact_unpinned', 'pending'),
      ('approval_malformed_exact', 'org_a', 'prj_a', 'op_malformed_exact', 'pending'),
      ('approval_pending_post_effect', 'org_a', 'prj_a', 'op_pending_post_effect', 'pending')`);

    await client.query(sql);

    const transfers = await client.query(
      `SELECT id, custody_wallet_id FROM payment_transfers ORDER BY id`
    );
    expect(transfers.rows).toEqual([
      { id: "xfr_ambiguous", custody_wallet_id: null },
      { id: "xfr_foreign", custody_wallet_id: null },
      { id: "xfr_inbound", custody_wallet_id: "cw_org" },
      { id: "xfr_org_connection", custody_wallet_id: null },
      { id: "xfr_outbound", custody_wallet_id: "cw_project" },
    ]);
    expect(
      (
        await client.query(
          `SELECT id, source_custody_wallet_id FROM payment_transfer_batches ORDER BY id`
        )
      ).rows
    ).toEqual([
      { id: "batch_ambiguous", source_custody_wallet_id: null },
      { id: "batch_unique", source_custody_wallet_id: "cw_connection" },
    ]);
    const requests = await client.query<{
      custody_wallet_id: string | null;
      id: string;
      lifecycle: Array<Record<string, unknown>>;
      status: string;
    }>(`SELECT id, custody_wallet_id, status, lifecycle FROM payment_requests ORDER BY id`);
    expect(requests.rows).toEqual([
      {
        id: "request_ambiguous",
        custody_wallet_id: null,
        status: "awaiting_payment",
        lifecycle: [],
      },
      {
        id: "request_unique",
        custody_wallet_id: "cw_project",
        status: "awaiting_payment",
        lifecycle: [],
      },
    ]);

    expect(
      (
        await client.query(
          `SELECT DISTINCT batch.id AS batch_id, transfer.id AS transfer_id
           FROM payment_transfer_batches batch
           JOIN payment_transfer_recipients recipient
             ON recipient.batch_id = batch.id
            AND recipient.organization_id = batch.organization_id
            AND recipient.project_id = batch.project_id
           JOIN payment_transfers transfer
             ON transfer.id = recipient.transfer_id
            AND transfer.organization_id = recipient.organization_id
            AND transfer.project_id = recipient.project_id
           WHERE batch.source_custody_wallet_id IS DISTINCT FROM transfer.custody_wallet_id
           ORDER BY batch.id, transfer.id`
        )
      ).rows
    ).toEqual([{ batch_id: "batch_unique", transfer_id: "xfr_outbound" }]);

    const operations = await client.query<{
      custody_wallet_id: string | null;
      id: string;
      raw_payload: Record<string, unknown>;
      status: string;
    }>(`SELECT id, custody_wallet_id, raw_payload, status FROM wallet_operations ORDER BY id`);
    const byId = new Map(operations.rows.map((row) => [row.id, row]));
    expect(byId.get("op_pinned")?.custody_wallet_id).toBe("cw_project");
    expect(byId.get("op_unique")?.custody_wallet_id).toBeNull();
    expect(byId.get("op_unique")?.raw_payload).toHaveProperty("source", "provider_connection");
    expect(byId.get("op_exact_unpinned")?.custody_wallet_id).toBeNull();
    expect(byId.get("op_ambiguous")?.status).toBe("pending_approval");
    expect(byId.get("op_malformed_exact")?.status).toBe("pending_approval");
    expect(byId.get("op_stale_pre_effect")?.status).toBe("executing");
    expect(byId.get("op_live")?.status).toBe("executing");
    expect(byId.get("op_live")?.raw_payload).toHaveProperty("source");
    expect(byId.get("op_post_effect")?.status).toBe("executing");
    expect(byId.get("op_pending_post_effect")?.status).toBe("pending_approval");

    expect(
      (
        await client.query(
          `SELECT wallet_operation_id, status FROM approval_requests
           WHERE wallet_operation_id = 'op_ambiguous'`
        )
      ).rows
    ).toEqual([{ wallet_operation_id: "op_ambiguous", status: "pending" }]);
    expect(
      (
        await client.query(
          `SELECT wallet_operation_id, status FROM approval_requests
           WHERE wallet_operation_id = 'op_pending_post_effect'`
        )
      ).rows
    ).toEqual([{ wallet_operation_id: "op_pending_post_effect", status: "pending" }]);

    const deleteReferenced = await client.query("SAVEPOINT before_delete").then(async () => {
      try {
        await client.query("DELETE FROM custody_wallets WHERE id = 'cw_project'");
        return null;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT before_delete");
        return error;
      }
    });
    expect(deleteReferenced).toMatchObject({ code: "23503" });

    const deleteRules = await client.query<{ conname: string; confdeltype: string }>(
      `SELECT conname, confdeltype
       FROM pg_constraint
       WHERE conname IN (
         'payment_transfers_custody_wallet_id_fkey',
         'payment_transfer_batches_source_custody_wallet_id_fkey',
         'payment_requests_custody_wallet_id_fkey',
         'wallet_operations_custody_wallet_id_fkey'
       )
         AND conrelid IN (
           'pg_temp.payment_transfers'::regclass,
           'pg_temp.payment_transfer_batches'::regclass,
           'pg_temp.payment_requests'::regclass,
           'pg_temp.wallet_operations'::regclass
         )
       ORDER BY conname`
    );
    expect(deleteRules.rows).toEqual([
      { conname: "payment_requests_custody_wallet_id_fkey", confdeltype: "a" },
      { conname: "payment_transfer_batches_source_custody_wallet_id_fkey", confdeltype: "a" },
      { conname: "payment_transfers_custody_wallet_id_fkey", confdeltype: "a" },
      { conname: "wallet_operations_custody_wallet_id_fkey", confdeltype: "a" },
    ]);

    await client.query(`INSERT INTO payment_transfers
      (id, organization_id, project_id, wallet_id, source_address, destination_address, direction)
      VALUES ('xfr_late', 'org_a', 'prj_a', 'provider_connection', 'addr_connection', 'dest', 'outbound')`);
    await client.query(`INSERT INTO payment_requests
      (id, organization_id, project_id, wallet_id, destination_address)
      VALUES ('request_late_unresolved', 'org_a', 'prj_a', 'provider_duplicate', 'addr_duplicate')`);
    await client.query(
      `INSERT INTO wallet_operations
        (id, organization_id, project_id, custody_wallet_id, wallet_id, operation_type,
         raw_payload, status, execution_lease_expires_at, execution_effect_started_at)
       VALUES ('op_late', 'org_a', 'prj_a', NULL, 'provider_connection',
         'payment_transfer_batch_execute', $1, 'pending_approval', NULL, NULL)`,
      [legacyEnvelope("provider_connection", "/v1/payments/transfer-batches")]
    );
    await client.query(`INSERT INTO approval_requests
      (id, organization_id, project_id, wallet_operation_id, status)
      VALUES ('approval_late', 'org_a', 'prj_a', 'op_late', 'pending')`);

    const catchUpSql = catchUpTransaction(readFileSync(catchUpPath, "utf8"));
    await client.query(catchUpSql);
    await client.query(catchUpSql);

    expect(
      (await client.query(`SELECT custody_wallet_id FROM payment_transfers WHERE id = 'xfr_late'`))
        .rows
    ).toEqual([{ custody_wallet_id: "cw_connection" }]);
    expect(
      (
        await client.query(
          `SELECT custody_wallet_id, raw_payload ->> 'source' AS source
           FROM wallet_operations WHERE id = 'op_late'`
        )
      ).rows
    ).toEqual([{ custody_wallet_id: null, source: "provider_connection" }]);
    expect(
      (
        await client.query(
          `SELECT status, jsonb_array_length(lifecycle) AS lifecycle_count
           FROM payment_requests WHERE id = 'request_late_unresolved'`
        )
      ).rows
    ).toEqual([{ status: "awaiting_payment", lifecycle_count: 0 }]);

    const missingPathEnvelope = JSON.parse(legacyEnvelope("provider_project")) as {
      executionRequest: Record<string, unknown>;
    };
    delete missingPathEnvelope.executionRequest.path;
    await client.query(
      `INSERT INTO wallet_operations
        (id, organization_id, project_id, custody_wallet_id, wallet_id, operation_type,
         raw_payload, status)
       VALUES
        ('op_audit_missing_path', 'org_a', 'prj_a', 'cw_project', 'provider_project',
         'payment_transfer_execute', $1, 'pending_approval'),
        ('op_audit_mismatched_pin', 'org_a', 'prj_a', 'cw_foreign', 'provider_project',
         'payment_transfer_execute', $2, 'pending_approval'),
        ('op_audit_exact_envelope', 'org_a', 'prj_a', 'cw_project', 'provider_project',
         'payment_transfer_execute', $3, 'pending_approval')`,
      [
        JSON.stringify(missingPathEnvelope),
        legacyEnvelope("provider_project"),
        exactEnvelope("cw_project", "addr_project"),
      ]
    );

    const auditSql = readFileSync(auditPath, "utf8");
    await client.query(withoutPsqlCommands(auditSql));
    const sectionStart = auditSql.indexOf("\\echo '=== 3.");
    const queryStart = auditSql.indexOf("\n", sectionStart) + 1;
    const sectionEnd = auditSql.indexOf("\\echo '=== 4.", queryStart);
    const auditRows = await client.query<{ classification: string; id: string }>(
      auditSql.slice(queryStart, sectionEnd)
    );
    expect(auditRows.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "op_audit_missing_path",
          classification: "malformed_legacy_envelope",
        }),
        expect.objectContaining({
          id: "op_audit_mismatched_pin",
          classification: "mismatched_exact_wallet",
        }),
        expect.objectContaining({
          id: "op_audit_exact_envelope",
          classification: "unsupported_exact_envelope",
        }),
      ])
    );
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
