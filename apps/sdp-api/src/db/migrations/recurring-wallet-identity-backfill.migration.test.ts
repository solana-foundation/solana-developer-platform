import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl, env } from "@/test/helpers/env";
import {
  seedCounterparty,
  seedOrgProject,
  seedStoredProviderCredential,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";

const migration = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "postgres/0156_recurring_wallet_roles.sql"
);

it("fills only unique scoped plan roles without rewriting recurring source identities", async () => {
  await seedTestDatabase(env);
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE payment_subscription_plans
      DROP COLUMN owner_custody_wallet_id, DROP COLUMN puller_custody_wallet_id`);
    const tenant = await seedOrgProject(client, "plan_role_backfill");
    const other = await seedOrgProject(client, "plan_role_backfill_other");
    await client.query(
      `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config_encrypted, status)
       VALUES ('cfg', $1, $2, 'local', 'test-only', 'active'),
              ('archived', $1, $2, 'local', 'test-only', 'archived'),
              ('foreign_org', $3, $4, 'local', 'test-only', 'active')`,
      [tenant.organizationId, tenant.projectId, other.organizationId, other.projectId]
    );
    for (const projectId of [tenant.projectId, `${tenant.projectId}_production`]) {
      await seedStoredProviderCredential(client, {
        id: `credential_${projectId}`,
        label: projectId,
        organizationId: tenant.organizationId,
        projectId,
        userId: tenant.userId,
        provider: "privy",
      });
      await client.query(
        `INSERT INTO custody_connections
           (id, organization_id, project_id, provider, scope, provider_credential_id,
            provider_credential_scope_key, status, deactivated_at)
         VALUES ($1, $2, $3, 'privy', 'project', $4, $3,
                 'deactivated', '2026-01-01T00:00:00.000Z')`,
        [`connection_${projectId}`, tenant.organizationId, projectId, `credential_${projectId}`]
      );
    }
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key, status)
      VALUES ('owner', 'cfg', 'owner_ref', 'owner_address', 'inactive'),
             ('alias_a', 'cfg', 'alias_ref', 'alias_address', 'active'),
             ('alias_b', 'archived', 'alias_ref', 'alias_address', 'inactive'),
             ('foreign_org_owner', 'foreign_org', 'foreign_org_ref', 'foreign_org_address', 'active')`);
    await client.query(
      `INSERT INTO custody_wallets
         (id, custody_connection_id, wallet_id, public_key, status)
       VALUES ('puller', $1, 'puller_ref', 'puller_address', 'inactive'),
              ('foreign_project_owner', $2, 'foreign_project_ref', 'foreign_project_address', 'inactive')`,
      [`connection_${tenant.projectId}`, `connection_${tenant.projectId}_production`]
    );
    await client.query(
      `INSERT INTO payment_subscription_plans
         (id, organization_id, project_id, owner_wallet_id, owner_address,
          puller_wallet_id, puller_address, token, amount, period_hours, program_plan_id, status)
       SELECT fixture.id, $1, $2, fixture.owner_ref, fixture.owner_address,
              fixture.puller_ref, fixture.puller_address, 'USDC', '25.00', 24, fixture.id, 'archived'
       FROM (VALUES
         ('unique', 'owner_ref', 'owner_address', 'puller_ref', 'puller_address'),
         ('ambiguous', 'alias_ref', 'alias_address', 'alias_ref', 'alias_address'),
         ('missing', 'missing_ref', 'missing_address', NULL, NULL),
         ('foreign_org_plan', 'foreign_org_ref', 'foreign_org_address', NULL, NULL),
         ('foreign_project_plan', 'foreign_project_ref', 'foreign_project_address', NULL, NULL),
         ('independent_owner', 'owner_ref', 'owner_address', 'puller_ref', 'wrong_address'),
         ('independent_puller', 'owner_ref', 'wrong_address', 'puller_ref', 'puller_address')
       ) fixture(id, owner_ref, owner_address, puller_ref, puller_address)`,
      [tenant.organizationId, tenant.projectId]
    );
    await seedCounterparty(client, {
      id: "counterparty",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await client.query(
      `INSERT INTO counterparty_accounts
         (id, organization_id, project_id, counterparty_id, account_kind, details)
       VALUES ('account', $1, $2, 'counterparty', 'crypto_wallet',
               '{"network":"solana","address":"destination"}')`,
      [tenant.organizationId, tenant.projectId]
    );
    await client.query(
      `INSERT INTO payment_recurring_payments
         (id, organization_id, project_id, source_wallet_id, source_address,
          source_custody_wallet_id, counterparty_id, counterparty_account_id,
          destination_address, token, amount, period_hours, plan_id, status)
       SELECT fixture.id, $1, $2, 'owner_ref', 'owner_address', fixture.pin,
              'counterparty', 'account', 'destination', 'USDC', '25.00', 24, 'unique', 'canceled'
       FROM (VALUES ('pinned', 'owner'), ('unpinned', NULL)) fixture(id, pin)`,
      [tenant.organizationId, tenant.projectId]
    );
    await client.query(
      `INSERT INTO payment_recurring_payment_update_attempts
         (id, organization_id, project_id, recurring_payment_id, mode, status,
          stage, new_source_custody_wallet_id)
       SELECT fixture.id, $1, $2, 'pinned', 'replacement', 'processing', 'create_plan', fixture.pin
       FROM (VALUES ('pinned_attempt', 'owner'), ('unpinned_attempt', NULL)) fixture(id, pin)`,
      [tenant.organizationId, tenant.projectId]
    );
    const retainedRows = async () => ({
      plans: (
        await client.query(`SELECT to_jsonb(plan) - 'owner_custody_wallet_id'
        - 'puller_custody_wallet_id' AS row FROM payment_subscription_plans plan ORDER BY id`)
      ).rows,
      recurring: (await client.query("SELECT * FROM payment_recurring_payments ORDER BY id")).rows,
      attempts: (
        await client.query("SELECT * FROM payment_recurring_payment_update_attempts ORDER BY id")
      ).rows,
    });
    const before = await retainedRows();

    await client.query(readFileSync(migration, "utf8"));

    expect(
      (
        await client.query(`SELECT id, owner_custody_wallet_id, puller_custody_wallet_id
      FROM payment_subscription_plans ORDER BY id`)
      ).rows
    ).toEqual([
      { id: "ambiguous", owner_custody_wallet_id: null, puller_custody_wallet_id: null },
      { id: "foreign_org_plan", owner_custody_wallet_id: null, puller_custody_wallet_id: null },
      { id: "foreign_project_plan", owner_custody_wallet_id: null, puller_custody_wallet_id: null },
      { id: "independent_owner", owner_custody_wallet_id: "owner", puller_custody_wallet_id: null },
      {
        id: "independent_puller",
        owner_custody_wallet_id: null,
        puller_custody_wallet_id: "puller",
      },
      { id: "missing", owner_custody_wallet_id: null, puller_custody_wallet_id: null },
      { id: "unique", owner_custody_wallet_id: "owner", puller_custody_wallet_id: "puller" },
    ]);
    expect(await retainedRows()).toEqual(before);
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
