import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { adminDatabaseUrl } from "@/test/helpers/env";

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");
/** Read one checked-in migration for the isolated fixture. */
export function sql(name: string): string {
  return readFileSync(path.join(here, "postgres", name), "utf8");
}
const expandSql = sql("0234_canonical_proposed_transactions.sql");
const backfillSql = sql("0235_canonical_signing_proposal_backfill.sql");
const NOW = "2026-11-20T15:00:00.000Z";
/** Isolated migration fixtures shared across the expand and contract suites. */
export function canonicalProposalMigrationFixture() {
  const client = new Client({ connectionString: adminDatabaseUrl });
  const schema = `canonical_proposals_${randomUUID().replaceAll("-", "")}`;

  async function setup() {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`SET search_path TO ${schema}, public`);
    await client.query("CREATE TABLE organizations (id TEXT PRIMARY KEY)");
    await client.query(
      "CREATE TABLE projects (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, UNIQUE(id, organization_id))"
    );
    await client.query("CREATE TABLE custody_wallets (id TEXT PRIMARY KEY)");
    await client.query(
      "CREATE TABLE payment_transfers (id TEXT PRIMARY KEY, organization_id TEXT NOT NULL, project_id TEXT NOT NULL, UNIQUE(id, organization_id, project_id))"
    );
    await client.query("INSERT INTO organizations VALUES ('org')");
    await client.query("INSERT INTO projects VALUES ('project', 'org')");
    await client.query("INSERT INTO custody_wallets VALUES ('wallet')");
    await client.query("INSERT INTO payment_transfers VALUES ('payment', 'org', 'project')");
    await client.query(sql("0229_fireblocks_signing_proposals.sql"));
    await client.query(sql("0231_custody_proposals.sql"));
  }
  async function teardown() {
    await client.query("SET search_path TO public");
    await client.query(`DROP SCHEMA ${schema} CASCADE`);
  }

  async function legacyProposal(
    id = "fbp_original",
    status = "PENDING_AUTHORIZATION",
    cancelRequestedAt: string | null = null
  ): Promise<void> {
    await client.query(
      `INSERT INTO fireblocks_signing_proposals
      (id, organization_id, project_id, custody_wallet_id, connection_id, account_fingerprint,
       vault_account_id, source_address, asset_id, operation, provider_transaction_id, status,
       request_id, cancel_requested_at, created_at, updated_at)
     VALUES ($1, 'org', 'project', 'wallet', 'connection', 'fingerprint', '0', 'source',
       'SOL_TEST', 'PROGRAM_CALL', $2, $3, 'request', $4, $5, $5)`,
      [id, status === "SUBMITTING" ? null : `provider_${id}`, status, cancelRequestedAt, NOW]
    );
  }
  async function migrate(): Promise<void> {
    await client.query(expandSql);
    await client.query(backfillSql);
  }
  async function canonical(id = "fbp_original"): Promise<Record<string, unknown>> {
    const result = await client.query<Record<string, unknown>>(
      "SELECT * FROM custody_proposals WHERE id = $1",
      [id]
    );
    const row = result.rows[0];
    if (!row) throw new Error("Canonical proposal is missing");
    return row;
  }
  async function refuse(id = "fbp_original"): Promise<void> {
    await client.query(
      `UPDATE custody_proposals SET authorization_state = 'refused', refused_at = $2,
      refusal_reason = 'cancellation_requested', refusal_message = 'Cancellation requested',
      version = version + 1 WHERE id = $1`,
      [id, NOW]
    );
  }

  return { client, schema, setup, teardown, legacyProposal, migrate, canonical, refuse };
}
