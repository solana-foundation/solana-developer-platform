import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0115_bvnk_virtual_settlement_wallet.sql"
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
  // Rewind to the pre-0115 (post-0113) schema: the CHECK members revert to
  // merchant_wallet and the settlement unique index swaps back to the
  // merchant one the migration drops.
  await client.query("BEGIN");
  await client.query(
    "DROP INDEX IF EXISTS counterparty_provider_accounts_active_virtual_settlement_wallet_unique"
  );
  await client.query(
    `CREATE UNIQUE INDEX counterparty_provider_accounts_active_merchant_wallet_unique
       ON counterparty_provider_accounts(counterparty_id, provider, fiat_currency)
       WHERE status = 'active' AND kind = 'merchant_wallet'`
  );
  await client.query(
    `ALTER TABLE counterparty_provider_accounts
       DROP CONSTRAINT counterparty_provider_accounts_kind_shape_check,
       DROP CONSTRAINT counterparty_provider_accounts_kind_check,
       ADD CONSTRAINT counterparty_provider_accounts_kind_check
         CHECK (kind IN ('customer_link', 'payout_account', 'virtual_funding_wallet', 'merchant_wallet')),
       ADD CONSTRAINT counterparty_provider_accounts_kind_shape_check
         CHECK (
           (kind = 'customer_link'
               AND fiat_currency IS NULL
               AND destination_country IS NULL
               AND external_account_reference IS NULL
               AND payment_rail IS NULL)
           OR (kind = 'payout_account'
               AND fiat_currency IS NOT NULL
               AND destination_country IS NOT NULL)
           OR (kind IN ('virtual_funding_wallet', 'merchant_wallet')
               AND fiat_currency IS NOT NULL
               AND destination_country IS NULL)
         )`
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

async function seedCorridorRows(
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
     VALUES ($1, $2, $3, 'individual', 'Ada 0115')`,
    [counterpartyId, orgId, projectId]
  );
}

describe("0115 bvnk virtual settlement wallet", () => {
  it("deletes merchant wallets, swaps the kind in the constraints and indexes, and strips the bvnk blob", async () => {
    await seedCorridorRows("org_0115", "usr_0115", "prj_0115", "cpty_0115");
    await client.query(
      `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name, provider_data)
       VALUES ('cpty_0115_nostrip', 'org_0115', 'prj_0115', 'individual', 'Bo 0115', '{}'::jsonb)`
    );
    await client.query(
      `UPDATE counterparties SET provider_data = '{"bvnk":{"customer":{"customerReference":"bvnk_0115"}},"stripe":{"key":"kept"}}'::jsonb
       WHERE id = 'cpty_0115'`
    );
    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, destination_country,
         external_account_reference, metadata
       ) VALUES
         ('cpa_merchant_0115', 'org_0115', 'prj_0115', 'cpty_0115', 'bvnk', 'bvnk_0115',
          'merchant_wallet', 'USD', NULL, 'wallet_merchant_0115', '{}'::jsonb),
         ('cpa_funding_0115', 'org_0115', 'prj_0115', 'cpty_0115', 'bvnk', 'bvnk_0115',
          'virtual_funding_wallet', 'USD', NULL, 'wallet_funding_0115', '{}'::jsonb),
         ('cpa_payout_0115', 'org_0115', 'prj_0115', 'cpty_0115', 'lightspark', 'ls_0115',
          'payout_account', 'USD', 'US', 'ExternalAccount:payout_0115', '{}'::jsonb)`
    );

    await client.query(migrationSql);

    const rows = await client.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM counterparty_provider_accounts
       WHERE id IN ('cpa_merchant_0115', 'cpa_funding_0115', 'cpa_payout_0115')
       ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { id: "cpa_funding_0115", kind: "virtual_funding_wallet" },
      { id: "cpa_payout_0115", kind: "payout_account" },
    ]);

    const constraints = await client.query<{ conname: string; def: string }>(
      `SELECT conname, pg_get_constraintdef(oid) AS def
       FROM pg_constraint
       WHERE conname IN (
         'counterparty_provider_accounts_kind_check',
         'counterparty_provider_accounts_kind_shape_check'
       )
       ORDER BY conname`
    );
    expect(constraints.rows).toHaveLength(2);
    for (const constraint of constraints.rows) {
      expect(constraint.def).toContain("virtual_settlement_wallet");
      expect(constraint.def).not.toContain("merchant_wallet");
    }

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'counterparty_provider_accounts'
         AND indexname IN (
           'counterparty_provider_accounts_active_virtual_settlement_wallet_unique',
           'counterparty_provider_accounts_active_merchant_wallet_unique'
         )`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "counterparty_provider_accounts_active_virtual_settlement_wallet_unique",
    ]);

    const providerData = await client.query<{ provider_data: Record<string, unknown> }>(
      `SELECT provider_data FROM counterparties
       WHERE id IN ('cpty_0115', 'cpty_0115_nostrip') ORDER BY id`
    );
    expect(providerData.rows).toEqual([
      { provider_data: { stripe: { key: "kept" } } },
      { provider_data: {} },
    ]);
  });

  it("enforces one active virtual settlement wallet per counterparty, provider, and fiat", async () => {
    await seedCorridorRows("org_0115_idx", "usr_0115_idx", "prj_0115_idx", "cpty_0115_idx");

    await client.query(migrationSql);

    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, destination_country,
         external_account_reference
       ) VALUES
         ('cpa_vsw_usd_0115', 'org_0115_idx', 'prj_0115_idx', 'cpty_0115_idx', 'bvnk',
          'bvnk_0115_idx', 'virtual_settlement_wallet', 'USD', NULL, 'wallet_usd_0115')`
    );

    await client.query("SAVEPOINT duplicate_corridor");
    await expect(
      client.query(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, fiat_currency, destination_country,
           external_account_reference
         ) VALUES
           ('cpa_vsw_usd_dup_0115', 'org_0115_idx', 'prj_0115_idx', 'cpty_0115_idx', 'bvnk',
            'bvnk_0115_idx', 'virtual_settlement_wallet', 'USD', NULL, 'wallet_usd_dup_0115')`
      )
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_corridor");

    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, destination_country,
         external_account_reference
       ) VALUES
         ('cpa_vsw_eur_0115', 'org_0115_idx', 'prj_0115_idx', 'cpty_0115_idx', 'bvnk',
          'bvnk_0115_idx', 'virtual_settlement_wallet', 'EUR', NULL, 'wallet_eur_0115')`
    );
  });
});
