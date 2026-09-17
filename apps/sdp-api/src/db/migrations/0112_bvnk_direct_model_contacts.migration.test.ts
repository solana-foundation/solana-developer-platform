import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0112_bvnk_direct_model_contacts.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparty_provider_accounts_bvnk_session_reference
       ON counterparty_provider_accounts (provider, (metadata->'session'->>'reference'))
       WHERE kind = 'customer_link' AND status = 'active'
         AND metadata->'session'->>'reference' IS NOT NULL`
  );
  await client.query(
    `ALTER TABLE counterparty_provider_accounts ALTER COLUMN provider_customer_reference SET NOT NULL`
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

async function seedCounterparty(
  orgId: string,
  userId: string,
  projectId: string,
  counterpartyId: string
) {
  await client.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)`, [
    orgId,
    `Org ${orgId}`,
    orgId,
  ]);
  await client.query(`INSERT INTO users (id, email) VALUES ($1, $2)`, [
    userId,
    `owner-${userId}@example.test`,
  ]);
  await client.query(
    `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
     VALUES
       ($1, $2, 'Default Sandbox Project', 'default-sandbox', 'sandbox', 'active', $3),
       ($4, $2, 'Default Production Project', 'default-production', 'production', 'active', $3)`,
    [projectId, orgId, userId, `${projectId}_production`]
  );
  await client.query(
    `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
     VALUES ($1, $2, $3, 'individual', 'Ada 0112')`,
    [counterpartyId, orgId, projectId]
  );
}

describe("0112 bvnk direct model contacts", () => {
  it("purges BVNK customer links, keeps other providers, drops the session index, and relaxes the reference", async () => {
    await seedCounterparty("org_0112", "usr_0112", "prj_0112", "cpty_0112");
    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, metadata
       ) VALUES
         ('cpa_bvnk_link_0112', 'org_0112', 'prj_0112', 'cpty_0112', 'bvnk', 'bvnk_customer_0112',
          'customer_link', '{"session":{"reference":"sess_0112"}}'::jsonb),
         ('cpa_ls_link_0112', 'org_0112', 'prj_0112', 'cpty_0112', 'lightspark', 'ls_customer_0112',
          'customer_link', '{}'::jsonb)`
    );

    await client.query(migrationSql);

    const rows = await client.query<{ id: string }>(
      `SELECT id FROM counterparty_provider_accounts
       WHERE id IN ('cpa_bvnk_link_0112', 'cpa_ls_link_0112')
       ORDER BY id`
    );
    expect(rows.rows).toEqual([{ id: "cpa_ls_link_0112" }]);

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'counterparty_provider_accounts'
         AND indexname = 'idx_counterparty_provider_accounts_bvnk_session_reference'`
    );
    expect(indexes.rows).toEqual([]);

    const column = await client.query<{ is_nullable: string }>(
      `SELECT is_nullable FROM information_schema.columns
       WHERE table_name = 'counterparty_provider_accounts'
         AND column_name = 'provider_customer_reference'`
    );
    expect(column.rows).toEqual([{ is_nullable: "YES" }]);
  });
});
