import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0112_bvnk_funding_wallet_per_fiat.sql"
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
    "DROP INDEX IF EXISTS counterparty_provider_accounts_active_funding_wallet_unique"
  );
  await client.query(
    `CREATE UNIQUE INDEX counterparty_provider_accounts_active_funding_wallet_unique
       ON counterparty_provider_accounts(counterparty_id, provider, (metadata->>'onrampKey'))
       WHERE status = 'active' AND kind = 'funding_wallet'`
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0112 BVNK funding wallet per fiat", () => {
  it("archives legacy onramp-key funding rows and deduplicates per fiat currency", async () => {
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org_0112', 'Org 0112', 'org-0112')`
    );
    await client.query(
      `INSERT INTO users (id, email) VALUES ('usr_0112', 'owner-0112@example.test')`
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       VALUES
         ('prj_0112', 'org_0112', 'Default Sandbox Project', 'default-sandbox', 'sandbox', 'active', 'usr_0112'),
         ('prj_0112_production', 'org_0112', 'Default Production Project', 'default-production', 'production', 'active', 'usr_0112')`
    );
    await client.query(
      `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
       VALUES
         ('cpty_0112', 'org_0112', 'prj_0112', 'individual', 'Ada 0112'),
         ('cpty_0112_production', 'org_0112', 'prj_0112_production', 'individual', 'Prod 0112')`
    );
    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, metadata
       ) VALUES
         ('cpa_funding_0112_a', 'org_0112', 'prj_0112', 'cpty_0112', 'bvnk', 'bvnk_0112_a', 'funding_wallet', 'USD', '{"onrampKey":"USD:USDC_SOLANA:dest-a"}'),
         ('cpa_funding_0112_b', 'org_0112', 'prj_0112', 'cpty_0112', 'bvnk', 'bvnk_0112_b', 'funding_wallet', 'USD', '{"onrampKey":"USD:USDC_SOLANA:dest-b"}'),
         ('cpa_funding_0112_production', 'org_0112', 'prj_0112_production', 'cpty_0112_production', 'bvnk', 'bvnk_0112_production', 'funding_wallet', 'USD', '{"onrampKey":"USD:USDC_SOLANA:dest-prod"}')`
    );

    await client.query(migrationSql);

    const rows = await client.query<{
      id: string;
      status: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, status, metadata FROM counterparty_provider_accounts WHERE id LIKE 'cpa_funding_0112_%' ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { id: "cpa_funding_0112_a", status: "archived", metadata: {} },
      { id: "cpa_funding_0112_b", status: "archived", metadata: {} },
      {
        id: "cpa_funding_0112_production",
        status: "active",
        metadata: { onrampKey: "USD:USDC_SOLANA:dest-prod" },
      },
    ]);

    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, metadata
       ) VALUES ('cpa_funding_0112_usd', 'org_0112', 'prj_0112', 'cpty_0112', 'bvnk', 'bvnk_0112', 'funding_wallet', 'USD', '{}')`
    );

    await client.query("SAVEPOINT duplicate_funding");
    await expect(
      client.query(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, fiat_currency, metadata
         ) VALUES ('cpa_funding_0112_dup', 'org_0112', 'prj_0112', 'cpty_0112', 'bvnk', 'bvnk_0112', 'funding_wallet', 'USD', '{}')`
      )
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_funding");

    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, metadata
       ) VALUES ('cpa_funding_0112_eur', 'org_0112', 'prj_0112', 'cpty_0112', 'bvnk', 'bvnk_0112', 'funding_wallet', 'EUR', '{}')`
    );
    const eurRow = await client.query<{ status: string }>(
      `SELECT status FROM counterparty_provider_accounts WHERE id = 'cpa_funding_0112_eur'`
    );
    expect(eurRow.rows).toEqual([{ status: "active" }]);
  });
});
