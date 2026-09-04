import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0078_counterparty_provider_account_kinds.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  await client.query("DROP INDEX counterparty_provider_accounts_customer_unique");
  await client.query("DROP INDEX counterparty_provider_accounts_active_corridor_idx");
  await client.query("DROP INDEX counterparty_provider_accounts_pending_reservation_unique");
  await client.query("DROP INDEX counterparty_provider_accounts_active_merchant_wallet_unique");
  await client.query("DROP INDEX counterparty_provider_accounts_active_funding_wallet_unique");
  await client.query(
    `ALTER TABLE counterparty_provider_accounts
       DROP CONSTRAINT counterparty_provider_accounts_kind_shape_check,
       DROP CONSTRAINT counterparty_provider_accounts_kind_check,
       ALTER COLUMN kind DROP NOT NULL,
       DROP COLUMN kind,
       ADD CONSTRAINT counterparty_provider_accounts_corridor_completeness_check
         CHECK ((fiat_currency IS NULL) = (destination_country IS NULL))`
  );
  await client.query(
    `CREATE UNIQUE INDEX counterparty_provider_accounts_customer_unique
       ON counterparty_provider_accounts(counterparty_id, provider)
       WHERE fiat_currency IS NULL`
  );
  await client.query(
    `CREATE INDEX counterparty_provider_accounts_active_corridor_idx
       ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency, destination_country)
       WHERE status = 'active' AND fiat_currency IS NOT NULL`
  );
  await client.query(
    `CREATE UNIQUE INDEX counterparty_provider_accounts_pending_reservation_unique
       ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency, destination_country, payment_rail)
       WHERE status = 'active' AND external_account_reference IS NULL AND payment_rail IS NOT NULL`
  );
  await client.query("ALTER TABLE counterparties ADD COLUMN bvnk_customer_reference TEXT");
  await client.query(
    `CREATE INDEX idx_counterparties_bvnk_customer_reference
       ON counterparties(bvnk_customer_reference)
       WHERE status = 'active' AND bvnk_customer_reference IS NOT NULL`
  );
  await client.query(
    `CREATE UNIQUE INDEX idx_counterparties_bvnk_customer_reference_active
       ON counterparties((provider_data->'bvnk'->'customer'->>'customerReference'))
       WHERE status = 'active' AND provider_data->'bvnk'->'customer'->>'customerReference' IS NOT NULL`
  );
  await client.query(
    `CREATE UNIQUE INDEX idx_counterparties_bvnk_customer_reference_denormalized_active
       ON counterparties(bvnk_customer_reference)
       WHERE status = 'active' AND bvnk_customer_reference IS NOT NULL`
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0078 counterparty provider-account kinds", () => {
  it("backfills customer and payout kinds, removes BVNK JSON, and drops the legacy column", async () => {
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org_0078', 'Org 0078', 'org-0078')`
    );
    await client.query(
      `INSERT INTO users (id, email) VALUES ('usr_0078', 'owner-0078@example.test')`
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, created_by)
       VALUES ('prj_0078', 'org_0078', 'Project 0078', 'project-0078', 'usr_0078')`
    );
    await client.query(
      `INSERT INTO counterparties (
         id, organization_id, project_id, entity_type, display_name, provider_data,
         bvnk_customer_reference
       ) VALUES
         ('cpty_0078', 'org_0078', 'prj_0078', 'individual', 'Ada 0078',
          '{"bvnk":{"customer":{"customerReference":"bvnk_0078"}}}', 'bvnk_0078')`
    );
    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, fiat_currency, destination_country
       ) VALUES
         ('cpa_customer_0078', 'org_0078', 'prj_0078', 'cpty_0078', 'bvnk', 'bvnk_0078', NULL, NULL),
         ('cpa_payout_0078', 'org_0078', 'prj_0078', 'cpty_0078', 'bvnk', 'bvnk_0078', 'USD', 'US')`
    );

    await client.query(migrationSql);

    const kinds = await client.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM counterparty_provider_accounts WHERE id LIKE 'cpa_%_0078' ORDER BY id`
    );
    expect(kinds.rows).toEqual([
      { id: "cpa_customer_0078", kind: "customer_link" },
      { id: "cpa_payout_0078", kind: "payout_account" },
    ]);

    const providerData = await client.query<{ provider_data: Record<string, unknown> }>(
      "SELECT provider_data FROM counterparties WHERE id = 'cpty_0078'"
    );
    expect(providerData.rows[0]?.provider_data).toEqual({});

    const legacyColumn = await client.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_name = 'counterparties' AND column_name = 'bvnk_customer_reference'`
    );
    expect(legacyColumn.rows).toEqual([]);
  });

  it("rejects a funding wallet with destination country data", async () => {
    await client.query(
      `INSERT INTO organizations (id, name, slug) VALUES ('org_0078_check', 'Org 0078 Check', 'org-0078-check')`
    );
    await client.query(
      `INSERT INTO users (id, email) VALUES ('usr_0078_check', 'owner-0078-check@example.test')`
    );
    await client.query(
      `INSERT INTO projects (id, organization_id, name, slug, created_by)
       VALUES ('prj_0078_check', 'org_0078_check', 'Project 0078 Check', 'project-0078-check', 'usr_0078_check')`
    );
    await client.query(
      `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
       VALUES ('cpty_0078_check', 'org_0078_check', 'prj_0078_check', 'individual', 'Ada Check')`
    );

    await client.query(migrationSql);

    await client.query("SAVEPOINT invalid_funding_wallet");
    await expect(
      client.query(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, fiat_currency, destination_country
         ) VALUES ('cpa_invalid_0078', 'org_0078_check', 'prj_0078_check',
                   'cpty_0078_check', 'bvnk', 'bvnk_check', 'funding_wallet', 'USD', 'US')`
      )
    ).rejects.toMatchObject({ code: "23514" });
    await client.query("ROLLBACK TO SAVEPOINT invalid_funding_wallet");
  });
});
