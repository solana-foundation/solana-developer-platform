import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0113_bvnk_virtual_funding_wallet.sql"
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
  // Rewind to the pre-0113 (post-0078) schema: the new CHECK members revert
  // to funding_wallet and the wallet-per-fiat unique index swaps back to the
  // per-onrampKey one the migration drops.
  await client.query("BEGIN");
  await client.query(
    "DROP INDEX counterparty_provider_accounts_active_virtual_funding_wallet_unique"
  );
  await client.query(
    `CREATE UNIQUE INDEX counterparty_provider_accounts_active_funding_wallet_unique
       ON counterparty_provider_accounts(counterparty_id, provider, (metadata->>'onrampKey'))
       WHERE status = 'active' AND kind = 'funding_wallet'`
  );
  await client.query(
    `ALTER TABLE counterparty_provider_accounts
       DROP CONSTRAINT counterparty_provider_accounts_kind_shape_check,
       DROP CONSTRAINT counterparty_provider_accounts_kind_check,
       ADD CONSTRAINT counterparty_provider_accounts_kind_check
         CHECK (kind IN ('customer_link', 'payout_account', 'funding_wallet', 'merchant_wallet')),
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
           OR (kind IN ('funding_wallet', 'merchant_wallet')
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
     VALUES ($1, $2, $3, 'individual', 'Ada 0113')`,
    [counterpartyId, orgId, projectId]
  );
}

describe("0113 bvnk virtual funding wallet", () => {
  it("deletes BVNK funding wallets, renames the rest, and swaps the kind in the constraints and index", async () => {
    await seedCorridorRows("org_0113", "usr_0113", "prj_0113", "cpty_0113");
    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, destination_country,
         external_account_reference, metadata
       ) VALUES
         ('cpa_bvnk_fund_0113', 'org_0113', 'prj_0113', 'cpty_0113', 'bvnk', 'bvnk_0113',
          'funding_wallet', 'USD', NULL, 'wallet_bvnk_0113', '{}'::jsonb),
         ('cpa_other_fund_0113', 'org_0113', 'prj_0113', 'cpty_0113', 'lightspark', 'ls_0113',
          'funding_wallet', 'EUR', NULL, 'wallet_other_0113', '{"onrampKey":"EUR:USDT_SOLANA:dest"}'::jsonb),
         ('cpa_merchant_0113', 'org_0113', 'prj_0113', 'cpty_0113', 'bvnk', 'bvnk_0113',
          'merchant_wallet', 'USD', NULL, 'wallet_merchant_0113', '{}'::jsonb)`
    );

    await client.query(migrationSql);

    const rows = await client.query<{ id: string; kind: string }>(
      `SELECT id, kind FROM counterparty_provider_accounts
       WHERE id IN ('cpa_bvnk_fund_0113', 'cpa_other_fund_0113', 'cpa_merchant_0113')
       ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { id: "cpa_merchant_0113", kind: "merchant_wallet" },
      { id: "cpa_other_fund_0113", kind: "virtual_funding_wallet" },
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
      expect(constraint.def).toContain("virtual_funding_wallet");
      expect(constraint.def).not.toContain("funding_wallet");
    }

    const indexes = await client.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
       WHERE schemaname = 'public' AND tablename = 'counterparty_provider_accounts'
         AND indexname IN (
           'counterparty_provider_accounts_active_virtual_funding_wallet_unique',
           'counterparty_provider_accounts_active_funding_wallet_unique'
         )`
    );
    expect(indexes.rows.map((row) => row.indexname)).toEqual([
      "counterparty_provider_accounts_active_virtual_funding_wallet_unique",
    ]);
  });

  it("enforces one active virtual funding wallet per counterparty, provider, and fiat", async () => {
    await seedCorridorRows("org_0113_idx", "usr_0113_idx", "prj_0113_idx", "cpty_0113_idx");

    await client.query(migrationSql);

    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, destination_country,
         external_account_reference
       ) VALUES
         ('cpa_vfw_usd_0113', 'org_0113_idx', 'prj_0113_idx', 'cpty_0113_idx', 'bvnk',
          'bvnk_0113_idx', 'virtual_funding_wallet', 'USD', NULL, 'wallet_usd_0113')`
    );

    await client.query("SAVEPOINT duplicate_corridor");
    await expect(
      client.query(
        `INSERT INTO counterparty_provider_accounts (
           id, organization_id, project_id, counterparty_id, provider,
           provider_customer_reference, kind, fiat_currency, destination_country,
           external_account_reference
         ) VALUES
           ('cpa_vfw_usd_dup_0113', 'org_0113_idx', 'prj_0113_idx', 'cpty_0113_idx', 'bvnk',
            'bvnk_0113_idx', 'virtual_funding_wallet', 'USD', NULL, 'wallet_usd_dup_0113')`
      )
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_corridor");

    await client.query(
      `INSERT INTO counterparty_provider_accounts (
         id, organization_id, project_id, counterparty_id, provider,
         provider_customer_reference, kind, fiat_currency, destination_country,
         external_account_reference
       ) VALUES
         ('cpa_vfw_eur_0113', 'org_0113_idx', 'prj_0113_idx', 'cpty_0113_idx', 'bvnk',
          'bvnk_0113_idx', 'virtual_funding_wallet', 'EUR', NULL, 'wallet_eur_0113')`
    );
  });
});
