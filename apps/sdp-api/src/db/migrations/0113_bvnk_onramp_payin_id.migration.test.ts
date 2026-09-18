import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0113_bvnk_onramp_payin_id.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

beforeAll(async () => {
  client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterAll(async () => {
  await client.end();
});

beforeEach(async () => {
  await client.query("BEGIN");
  await client.query("DROP INDEX IF EXISTS payment_transfers_bvnk_onramp_payin_id_unique");
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

async function seedOrganizationAndProjects(): Promise<void> {
  await client.query(
    `INSERT INTO organizations (id, name, slug) VALUES ('org_0113', 'Org 0113', 'org-0113')`
  );
  await client.query(
    `INSERT INTO users (id, email) VALUES ('usr_0113', 'owner-0113@example.test')`
  );
  await client.query(
    `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
     VALUES
       ('prj_0113', 'org_0113', 'Default Sandbox Project', 'default-sandbox', 'sandbox', 'active', 'usr_0113'),
       ('prj_0113_production', 'org_0113', 'Default Production Project', 'default-production', 'production', 'active', 'usr_0113')`
  );
  await client.query(
    `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name)
     VALUES
       ('cpty_0113', 'org_0113', 'prj_0113', 'individual', 'Ada 0113'),
       ('cpty_0113_production', 'org_0113', 'prj_0113_production', 'individual', 'Prod 0113')`
  );
}

async function insertFundingRow(params: {
  id: string;
  projectId: string;
  counterpartyId: string;
  provider: string;
  providerStatus: string | null;
  metadata: Record<string, unknown>;
  /** The 0112 unique index allows ONE active funding wallet per counterparty, provider, and fiat. */
  fiatCurrency?: string;
}): Promise<void> {
  const providerStatus = params.providerStatus === null ? "NULL" : `'${params.providerStatus}'`;
  const fiatCurrency = params.fiatCurrency ?? "USD";
  await client.query(
    `INSERT INTO counterparty_provider_accounts (
       id, organization_id, project_id, counterparty_id, provider,
       provider_customer_reference, kind, fiat_currency, external_account_reference,
       provider_status, status, metadata
     ) VALUES ('${params.id}', 'org_0113', '${params.projectId}', '${params.counterpartyId}', '${params.provider}', 'bvnk_${params.id}', 'funding_wallet', '${fiatCurrency}', 'a:wallet:${params.id}', ${providerStatus}, 'active', '${JSON.stringify(params.metadata)}')`
  );
}

async function insertBvnkTransfer(params: {
  id: string;
  projectId: string;
  counterpartyId: string;
  status: string;
  providerData: Record<string, unknown>;
}): Promise<void> {
  await client.query(
    `INSERT INTO payment_transfers (
       id, organization_id, project_id, counterparty_id, wallet_id, token,
       amount, type, direction, status, provider, provider_data, created_at, updated_at
     ) VALUES ('${params.id}', 'org_0113', '${params.projectId}', '${params.counterpartyId}', 'w_0113', 'USDC', '1', 'onramp', 'inbound', '${params.status}', 'bvnk', '${JSON.stringify(params.providerData)}', sdp_iso_now(), sdp_iso_now())`
  );
}

describe("0113 BVNK on-ramp pay-in id pivot", () => {
  it("resets sandbox locked funding wallets and fails in-flight sandbox on-ramp transfers", async () => {
    await seedOrganizationAndProjects();
    await insertFundingRow({
      id: "cpa_locked_0113",
      projectId: "prj_0113",
      counterpartyId: "cpty_0113",
      provider: "bvnk",
      providerStatus: "funding_wallet_locked",
      metadata: { transferId: "xfr_legacy_0113" },
    });
    // The second active BVNK wallet is a DIFFERENT fiat (USD/EUR), so the
    // pre-migration state stays legal under the 0112 active-funding-wallet
    // unique index while still exercising the legacy archive UPDATE.
    await insertFundingRow({
      id: "cpa_legacy_0113",
      projectId: "prj_0113",
      counterpartyId: "cpty_0113",
      provider: "bvnk",
      providerStatus: null,
      fiatCurrency: "EUR",
      metadata: { onrampKey: "USD:USDC_SOLANA:dest-a" },
    });
    await insertFundingRow({
      id: "cpa_other_provider_0113",
      projectId: "prj_0113",
      counterpartyId: "cpty_0113",
      provider: "circle",
      providerStatus: null,
      metadata: { kept: "yes" },
    });
    await insertBvnkTransfer({
      id: "xfr_settling_0113",
      projectId: "prj_0113",
      counterpartyId: "cpty_0113",
      status: "settling",
      providerData: { bvnk: { payin: { id: "payin_0113_a" } } },
    });

    await client.query(migrationSql);

    const fundingRows = await client.query<{
      id: string;
      provider_status: string | null;
      status: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT id, provider_status, status, metadata
       FROM counterparty_provider_accounts
       WHERE id IN ('cpa_locked_0113', 'cpa_legacy_0113', 'cpa_other_provider_0113')
       ORDER BY id`
    );
    // The query orders by id, so the lexicographically-first legacy row leads.
    expect(fundingRows.rows).toEqual([
      { id: "cpa_legacy_0113", provider_status: null, status: "archived", metadata: {} },
      {
        id: "cpa_locked_0113",
        provider_status: "provisioned_funding_wallet",
        status: "active",
        metadata: {},
      },
      {
        id: "cpa_other_provider_0113",
        provider_status: null,
        status: "active",
        metadata: { kept: "yes" },
      },
    ]);

    const transfer = await client.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM payment_transfers WHERE id = 'xfr_settling_0113'`
    );
    expect(transfer.rows).toEqual([
      { status: "failed", error: "BVNK on-ramp payment rules retired" },
    ]);
  });

  it("migration_0113_preserves_production_rows", async () => {
    await seedOrganizationAndProjects();
    await insertFundingRow({
      id: "cpa_locked_production_0113",
      projectId: "prj_0113_production",
      counterpartyId: "cpty_0113_production",
      provider: "bvnk",
      providerStatus: "funding_wallet_locked",
      metadata: { transferId: "xfr_production_0113" },
    });
    await insertBvnkTransfer({
      id: "xfr_settling_production_0113",
      projectId: "prj_0113_production",
      counterpartyId: "cpty_0113_production",
      status: "settling",
      providerData: { bvnk: { payin: { id: "payin_0113_prod" } } },
    });

    await client.query(migrationSql);

    const fundingRow = await client.query<{
      provider_status: string | null;
      status: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT provider_status, status, metadata
       FROM counterparty_provider_accounts
       WHERE id = 'cpa_locked_production_0113'`
    );
    expect(fundingRow.rows).toEqual([
      {
        provider_status: "funding_wallet_locked",
        status: "active",
        metadata: { transferId: "xfr_production_0113" },
      },
    ]);

    const transfer = await client.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM payment_transfers WHERE id = 'xfr_settling_production_0113'`
    );
    expect(transfer.rows).toEqual([{ status: "settling", error: null }]);
  });

  it("creates the unique pay-in expression index and rejects a second transfer claiming the same pay-in id", async () => {
    await seedOrganizationAndProjects();

    await client.query(migrationSql);

    const indexRows = await client.query<{ indexname: string }>(
      `SELECT indexname
       FROM pg_indexes
       WHERE indexname = 'payment_transfers_bvnk_onramp_payin_id_unique'`
    );
    expect(indexRows.rows).toHaveLength(1);

    await insertBvnkTransfer({
      id: "xfr_dup_first_0113",
      projectId: "prj_0113",
      counterpartyId: "cpty_0113",
      status: "settling",
      providerData: { bvnk: { payin: { id: "payin_0113_dup" } } },
    });

    await client.query("SAVEPOINT duplicate_payin");
    await expect(
      client.query(
        `INSERT INTO payment_transfers (
           id, organization_id, project_id, counterparty_id, wallet_id, token,
           amount, type, direction, status, provider, provider_data, created_at, updated_at
         ) VALUES ('xfr_dup_second_0113', 'org_0113', 'prj_0113', 'cpty_0113', 'w_0113', 'USDC', '1', 'onramp', 'inbound', 'settling', 'bvnk', '{"bvnk":{"payin":{"id":"payin_0113_dup"}}}', sdp_iso_now(), sdp_iso_now())`
      )
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT duplicate_payin");
  });
});
