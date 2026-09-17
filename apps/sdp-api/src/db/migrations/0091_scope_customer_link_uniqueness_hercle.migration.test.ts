import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env } from "@/test/helpers/env";

const migrationPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0091_scope_customer_link_uniqueness_hercle.sql"
);
const migrationSql = readFileSync(migrationPath, "utf8");
let client: Client;

/**
 * Seeds two counterparties in two separate organizations, so a duplicate
 * customer link would resolve a Hercle webhook to the wrong tenant.
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
       ('cpty_a_${suffix}', 'org_a_${suffix}', 'prj_a_${suffix}', 'business', 'Acme ${suffix}'),
       ('cpty_b_${suffix}', 'org_b_${suffix}', 'prj_b_${suffix}', 'business', 'Bolt ${suffix}')`
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

// The test DB has all migrations applied. Rewind to the 0082 state — the index
// scoped to bvnk/lightspark only — which is what 0091 extends.
beforeEach(async () => {
  await client.query("BEGIN");
  await client.query("DROP INDEX idx_counterparty_provider_accounts_customer_link_reference");
  await client.query(
    `CREATE UNIQUE INDEX idx_counterparty_provider_accounts_customer_link_reference
       ON counterparty_provider_accounts(provider, provider_customer_reference)
       WHERE status = 'active'
         AND kind = 'customer_link'
         AND provider IN ('bvnk', 'lightspark')
         AND provider_customer_reference IS NOT NULL`
  );
});

afterEach(async () => {
  await client.query("ROLLBACK");
});

describe("0091 scope customer-link uniqueness to Hercle", () => {
  it("two tenants could claim one Hercle account before 0091, and 0091 refuses the second", async () => {
    await seedCounterpartyPair("0091");
    await insertCustomerLink({
      suffix: "0091",
      side: "a",
      provider: "hercle",
      reference: "acct_shared_0091",
      status: "active",
    });
    await insertCustomerLink({
      suffix: "0091",
      side: "b",
      provider: "hercle",
      reference: "acct_shared_0091",
      status: "active",
    });
    await client.query("DELETE FROM counterparty_provider_accounts WHERE id = 'cpa_b_0091'");

    await client.query(migrationSql);

    await client.query("SAVEPOINT dup_hercle_scoped");
    await expect(
      insertCustomerLink({
        suffix: "0091",
        side: "b",
        provider: "hercle",
        reference: "acct_shared_0091",
        status: "active",
      })
    ).rejects.toMatchObject({ code: "23505" });
    await client.query("ROLLBACK TO SAVEPOINT dup_hercle_scoped");
  });

  it.each([
    { provider: "bvnk", suffix: "bvnk_0091" },
    { provider: "lightspark", suffix: "lsp_0091" },
  ])(
    "keeps rejecting duplicate active $provider customer links after 0091",
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

  it("still lets one MoonPay account link to many counterparties after 0091", async () => {
    await seedCounterpartyPair("mp_0091");
    await client.query(migrationSql);

    await insertCustomerLink({
      suffix: "mp_0091",
      side: "a",
      provider: "moonpay",
      reference: "ref_shared_mp_0091",
      status: "active",
    });
    await insertCustomerLink({
      suffix: "mp_0091",
      side: "b",
      provider: "moonpay",
      reference: "ref_shared_mp_0091",
      status: "active",
    });

    const rows = await client.query<{ id: string }>(
      `SELECT id FROM counterparty_provider_accounts
       WHERE id IN ('cpa_a_mp_0091', 'cpa_b_mp_0091') ORDER BY id`
    );
    expect(rows.rows).toEqual([{ id: "cpa_a_mp_0091" }, { id: "cpa_b_mp_0091" }]);
  });

  it("archived Hercle rows do not collide with active links after 0091", async () => {
    await seedCounterpartyPair("arch_0091");
    await client.query(migrationSql);

    await insertCustomerLink({
      suffix: "arch_0091",
      side: "a",
      provider: "hercle",
      reference: "acct_arch_0091",
      status: "active",
    });
    await insertCustomerLink({
      suffix: "arch_0091",
      side: "b",
      provider: "hercle",
      reference: "acct_arch_0091",
      status: "archived",
    });

    const rows = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM counterparty_provider_accounts
       WHERE id IN ('cpa_a_arch_0091', 'cpa_b_arch_0091') ORDER BY id`
    );
    expect(rows.rows).toEqual([
      { id: "cpa_a_arch_0091", status: "active" },
      { id: "cpa_b_arch_0091", status: "archived" },
    ]);
  });
});
