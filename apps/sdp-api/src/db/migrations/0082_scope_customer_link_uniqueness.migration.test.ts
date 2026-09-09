import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0082_scope_customer_link_uniqueness.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

/**
 * Seeds two counterparties in two separate organizations so duplicate
 * customer links span tenants, mirroring the real MoonPay case (one
 * buyer-owned account linked from several organizations).
 *
 * @param suffix Unique fixture suffix; ids become `org_a_<suffix>` / `org_b_<suffix>` etc.
 * @returns Nothing; rows exist for the duration of the test transaction.
 */
async function seedCounterpartyPair(suffix: string): Promise<void> {
  const slug = suffix.replaceAll("_", "-");
  await client.query(
    `INSERT INTO organizations (id, name, slug) VALUES
       ('org_a_${suffix}', 'Org A ${suffix}', 'org-a-${slug}'),
       ('org_b_${suffix}', 'Org B ${suffix}', 'org-b-${slug}')`
  );
  await client.query(
    `INSERT INTO users (id, email) VALUES
       ('usr_a_${suffix}', 'owner-a-${slug}@example.test'),
       ('usr_b_${suffix}', 'owner-b-${slug}@example.test')`
  );
  await client.query(
    `INSERT INTO projects (id, organization_id, name, slug, created_by) VALUES
       ('prj_a_${suffix}', 'org_a_${suffix}', 'Project A ${suffix}', 'project-a-${slug}', 'usr_a_${suffix}'),
       ('prj_b_${suffix}', 'org_b_${suffix}', 'Project B ${suffix}', 'project-b-${slug}', 'usr_b_${suffix}')`
  );
  await client.query(
    `INSERT INTO counterparties (id, organization_id, project_id, entity_type, display_name) VALUES
       ('cpty_a_${suffix}', 'org_a_${suffix}', 'prj_a_${suffix}', 'individual', 'Ada ${suffix}'),
       ('cpty_b_${suffix}', 'org_b_${suffix}', 'prj_b_${suffix}', 'individual', 'Bob ${suffix}')`
  );
}

/**
 * Inserts one customer-link row for a seeded counterparty pair.
 *
 * @param params.suffix Fixture suffix used by {@link seedCounterpartyPair}.
 * @param params.side Which seeded tenant owns the row (`a` or `b`).
 * @param params.provider Ramp provider id for the link.
 * @param params.reference Provider customer reference the link claims.
 * @param params.status Row status; the uniqueness index only covers `active`.
 * @returns The insert promise, so callers can assert rejection.
 */
function insertCustomerLink(params: {
  suffix: string;
  side: "a" | "b";
  provider: string;
  reference: string;
  status: "active" | "archived";
}): Promise<unknown> {
  const { suffix, side, provider, reference, status } = params;
  return client.query(
    `INSERT INTO counterparty_provider_accounts (
       id, organization_id, project_id, counterparty_id, provider,
       provider_customer_reference, kind, status
     ) VALUES
       ('cpa_${side}_${suffix}', 'org_${side}_${suffix}', 'prj_${side}_${suffix}',
        'cpty_${side}_${suffix}', '${provider}', '${reference}', 'customer_link', '${status}')`
  );
}

beforeAll(async () => {
  client = new Client({ connectionString: env.DATABASE_URL });
  await client.connect();
  await client.query("SET app.tenant_isolation_identity = 'system'");
});

afterAll(async () => {
  await client.end();
});

// The test DB has all migrations applied, so the scoped index from the
// amended 0080/0082 already exists. Rewind to the pre-0082 state: drop the
// scoped index and recreate the ORIGINAL broad 0080 index that covered every
// provider, which is the regression 0082 fixes.
beforeEach(async () => {
  await client.query("BEGIN");
  await client.query("DROP INDEX idx_counterparty_provider_accounts_customer_link_reference");
  await client.query(
    `CREATE UNIQUE INDEX idx_counterparty_provider_accounts_customer_link_reference
       ON counterparty_provider_accounts(provider, provider_customer_reference)
       WHERE status = 'active'
         AND kind = 'customer_link'
         AND provider_customer_reference IS NOT NULL`
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0082 scope customer-link uniqueness", () => {
  it("broad index blocks MoonPay duplicates before 0082, and 0082 unblocks them", async () => {
    await seedCounterpartyPair("0082");
    await insertCustomerLink({
      suffix: "0082",
      side: "a",
      provider: "moonpay",
      reference: "ref_shared_0082",
      status: "active",
    });

    await client.query("SAVEPOINT dup_moonpay_broad");
    await expect(
      insertCustomerLink({
        suffix: "0082",
        side: "b",
        provider: "moonpay",
        reference: "ref_shared_0082",
        status: "active",
      })
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT dup_moonpay_broad");

    await client.query(migrationSql);

    await insertCustomerLink({
      suffix: "0082",
      side: "b",
      provider: "moonpay",
      reference: "ref_shared_0082",
      status: "active",
    });

    const active = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM counterparty_provider_accounts
       WHERE id IN ('cpa_a_0082', 'cpa_b_0082') ORDER BY id`
    );
    expect(active.rows).toEqual([
      { id: "cpa_a_0082", status: "active" },
      { id: "cpa_b_0082", status: "active" },
    ]);
  });

  it.each([
    { provider: "bvnk", suffix: "bvnk_0082" },
    { provider: "lightspark", suffix: "lsp_0082" },
  ])(
    "rejects duplicate active $provider customer links after 0082",
    async ({ provider, suffix }) => {
      await seedCounterpartyPair(suffix);
      await client.query(migrationSql);

      await insertCustomerLink({
        suffix,
        side: "a",
        provider,
        reference: `ref_${suffix}`,
        status: "active",
      });

      await client.query("SAVEPOINT dup_scoped");
      await expect(
        insertCustomerLink({
          suffix,
          side: "b",
          provider,
          reference: `ref_${suffix}`,
          status: "active",
        })
      ).rejects.toMatchObject({ code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT dup_scoped");
    }
  );

  it("archived rows do not collide with active links after 0082", async () => {
    await seedCounterpartyPair("arch_0082");
    await client.query(migrationSql);

    await insertCustomerLink({
      suffix: "arch_0082",
      side: "a",
      provider: "bvnk",
      reference: "ref_arch_0082",
      status: "active",
    });
    await insertCustomerLink({
      suffix: "arch_0082",
      side: "b",
      provider: "bvnk",
      reference: "ref_arch_0082",
      status: "archived",
    });

    const rows = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM counterparty_provider_accounts
       WHERE id IN ('cpa_a_arch_0082', 'cpa_b_arch_0082') ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { id: "cpa_a_arch_0082", status: "active" },
      { id: "cpa_b_arch_0082", status: "archived" },
    ]);
  });
});
