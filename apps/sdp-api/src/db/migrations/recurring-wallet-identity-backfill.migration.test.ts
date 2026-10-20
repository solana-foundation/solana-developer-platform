import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import type {
  PaymentRecurringPaymentRow,
  PaymentRecurringPaymentUpdateAttemptRow,
} from "@/db/repositories/payment-recurring-payments.repository";
import type { PaymentSubscriptionPlanRow } from "@/db/repositories/payment-subscriptions.repository";
import { runPostgresMigrations } from "@/scripts/lib/run-postgres-migrations.mjs";
import { adminDatabaseUrl, env } from "@/test/helpers/env";
import {
  RAISE_EXCEPTION,
  seedCounterparty,
  seedOrgProject,
  seedStoredProviderCredential,
} from "@/test/helpers/migration-db";
import { seedTestDatabase } from "@/test/mocks/db";

const migrationsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "postgres");
const migration = "0153_recurring_wallet_roles_and_sponsorship.sql";
const databaseUrl = env.DATABASE_URL;
if (!databaseUrl) throw new Error("Migration tests require DATABASE_URL");

it("adds and fills only new plan roles while preserving retained recurring identities", async () => {
  await seedTestDatabase(env);
  const client = new Client({ connectionString: adminDatabaseUrl });
  const runtime = new Client({ connectionString: databaseUrl });
  await client.connect();
  await runtime.connect();
  try {
    await client.query(`ALTER TABLE payment_subscription_plans
      DROP COLUMN owner_custody_wallet_id,
      DROP COLUMN puller_custody_wallet_id`);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [migration]);
    const tenant = await seedOrgProject(client, "recurring_auto_backfill");
    await client.query(
      `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config_encrypted, status)
       VALUES ('cfg_auto_backfill', $1, $2, 'local', 'test-only', 'active')`,
      [tenant.organizationId, tenant.projectId]
    );
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key, status)
      VALUES
        ('owner_auto_backfill', 'cfg_auto_backfill', 'owner_provider', 'owner_address', 'active'),
        ('puller_auto_backfill', 'cfg_auto_backfill', 'puller_provider', 'puller_address', 'inactive')`);
    await client.query(
      `INSERT INTO payment_subscription_plans
         (id, organization_id, project_id, owner_wallet_id, owner_address,
          puller_wallet_id, puller_address, token, amount, period_hours,
          program_plan_id, plan_pda, destination_address, metadata_uri,
          status, created_at, updated_at)
       VALUES
         ('legacy_auto_backfill', $1, $2, 'owner_provider', 'owner_address',
          'puller_provider', 'puller_address', 'USDC', '25.00', 24,
          'legacy_auto_backfill', 'legacy_plan_pda', 'destination_address',
          'https://example.test/legacy.json', 'active',
          '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'),
         ('replacement_auto_backfill', $1, $2, 'owner_provider', 'owner_address',
          'puller_provider', 'puller_address', 'USDC', '50.00', 24,
          'replacement_auto_backfill', 'replacement_plan_pda', 'destination_address',
          'https://example.test/replacement.json', 'archived',
          '2026-01-03T00:00:00.000Z', '2026-01-04T00:00:00.000Z')`,
      [tenant.organizationId, tenant.projectId]
    );
    await seedCounterparty(client, {
      id: "counterparty_auto_backfill",
      organizationId: tenant.organizationId,
      projectId: tenant.projectId,
    });
    await client.query(
      `INSERT INTO counterparty_accounts
         (id, organization_id, project_id, counterparty_id, account_kind, details)
       VALUES ('account_auto_backfill', $1, $2, 'counterparty_auto_backfill',
               'crypto_wallet', '{"network":"solana","address":"destination_address"}')`,
      [tenant.organizationId, tenant.projectId]
    );
    await client.query(
      `INSERT INTO payment_recurring_payments
         (id, organization_id, project_id, source_wallet_id, source_address,
          source_custody_wallet_id, counterparty_id, counterparty_account_id,
          destination_address, token, amount, period_hours, plan_id,
          plan_creation_signature, authorization_signature, next_collection_due_at,
          status, created_at, updated_at)
       SELECT fixture.id, $1, $2, 'owner_provider', 'owner_address',
              fixture.source_pin, 'counterparty_auto_backfill', 'account_auto_backfill',
              'destination_address', 'USDC', '25.00', 24, 'legacy_auto_backfill',
              'retained_plan_signature', 'retained_authorization_signature',
              '2026-02-01T00:00:00.000Z', 'canceled',
              '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
       FROM (VALUES
         ('recurring_auto_backfill', 'owner_auto_backfill'),
         ('recurring_legacy_auto_backfill', NULL)
       ) AS fixture(id, source_pin)`,
      [tenant.organizationId, tenant.projectId]
    );
    await client.query(
      `INSERT INTO payment_recurring_payment_update_attempts
         (id, organization_id, project_id, recurring_payment_id, mode, status,
          stage, old_plan_id, new_plan_id, new_source_custody_wallet_id,
          authorization_setup_signature, authorization_signature, old_cancel_signature,
          before_values, after_values, changed_fields, created_at, updated_at)
       VALUES ('amount_only_auto_backfill', $1, $2, 'recurring_auto_backfill',
               'replacement', 'processing', 'authorize_subscription',
               'legacy_auto_backfill', 'replacement_auto_backfill', NULL,
               'retained_setup_signature', 'retained_authorization_signature',
               'retained_cancel_signature',
               '{"sourceCustodyWalletId":"owner_auto_backfill",
                 "counterpartyId":"counterparty_auto_backfill",
                 "counterpartyAccountId":"account_auto_backfill","token":"USDC",
                 "amount":"25.00","periodHours":24,"firstCollectionAt":null,
                 "nextCollectionDueAt":"2026-02-01T00:00:00.000Z","metadataUri":null}',
               '{"sourceCustodyWalletId":"owner_auto_backfill",
                 "counterpartyId":"counterparty_auto_backfill",
                 "counterpartyAccountId":"account_auto_backfill","token":"USDC",
                 "amount":"50.00","periodHours":24,"firstCollectionAt":null,
                 "nextCollectionDueAt":"2026-02-01T00:00:00.000Z","metadataUri":null}',
               ARRAY['amount'],
               '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      [tenant.organizationId, tenant.projectId]
    );
    const snapshot = async () => ({
      plans: (
        await client.query<PaymentSubscriptionPlanRow>(
          "SELECT * FROM payment_subscription_plans ORDER BY id"
        )
      ).rows,
      recurring: (
        await client.query<PaymentRecurringPaymentRow>(
          "SELECT * FROM payment_recurring_payments ORDER BY id"
        )
      ).rows,
      attempts: (
        await client.query<PaymentRecurringPaymentUpdateAttemptRow>(
          "SELECT * FROM payment_recurring_payment_update_attempts ORDER BY id"
        )
      ).rows,
    });
    const before = await snapshot();
    expect(
      (
        await runtime.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
          "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"
        )
      ).rows
    ).toEqual([{ rolsuper: false, rolbypassrls: false }]);
    expect((await runtime.query("SELECT id FROM payment_subscription_plans")).rows).toEqual([]);

    await runPostgresMigrations({ databaseUrl, migrationsDir });

    const first = await snapshot();
    expect(first).toEqual({
      ...before,
      plans: before.plans.map((plan) => ({
        ...plan,
        owner_custody_wallet_id: "owner_auto_backfill",
        puller_custody_wallet_id: "puller_auto_backfill",
      })),
    });
    expect(
      (
        await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = $1",
          [migration]
        )
      ).rows
    ).toEqual([{ version: migration }]);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
    expect(await snapshot()).toEqual(first);
    expect((await runtime.query("SELECT id FROM payment_subscription_plans")).rows).toEqual([]);
  } finally {
    try {
      await seedTestDatabase(env);
      await runPostgresMigrations({ databaseUrl, migrationsDir });
    } finally {
      await Promise.all([client.end(), runtime.end()]);
    }
  }
});

it("rolls back schema and plan fills together, then fills only unique scoped roles", async () => {
  await seedTestDatabase(env);
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query(`ALTER TABLE payment_subscription_plans
      DROP COLUMN owner_custody_wallet_id,
      DROP COLUMN puller_custody_wallet_id`);
    await client.query("DELETE FROM schema_migrations WHERE version = $1", [migration]);
    const tenant = await seedOrgProject(client, "recurring_retained_backfill");
    const otherTenant = await seedOrgProject(client, "recurring_retained_backfill_other");
    await client.query(
      `INSERT INTO custody_configs
         (id, organization_id, project_id, provider, config_encrypted, status)
       VALUES
         ('cfg', $1, $2, 'local', 'test-only', 'active'),
         ('archived', $1, $2, 'local', 'test-only', 'archived'),
         ('foreign_org', $3, $4, 'local', 'test-only', 'active')`,
      [tenant.organizationId, tenant.projectId, otherTenant.organizationId, otherTenant.projectId]
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
         VALUES ($1, $2, $3, 'privy', 'project', $4, $3, 'deactivated',
                 '2026-01-01T00:00:00.000Z')`,
        [`connection_${projectId}`, tenant.organizationId, projectId, `credential_${projectId}`]
      );
    }
    await client.query(`INSERT INTO custody_wallets
      (id, custody_config_id, wallet_id, public_key, status)
      VALUES
        ('owner', 'cfg', 'owner_ref', 'owner_address', 'inactive'),
        ('collision_a', 'cfg', 'collision_ref', 'collision_address', 'active'),
        ('collision_b', 'archived', 'collision_ref', 'collision_address', 'inactive'),
        ('foreign_org_owner', 'foreign_org', 'foreign_org_ref', 'foreign_org_address', 'active')`);
    await client.query(
      `INSERT INTO custody_wallets
         (id, custody_connection_id, wallet_id, public_key, status)
       VALUES
         ('puller', $1, 'puller_ref', 'puller_address', 'inactive'),
         ('foreign_project_owner', $2, 'foreign_project_ref', 'foreign_project_address', 'inactive')`,
      [`connection_${tenant.projectId}`, `connection_${tenant.projectId}_production`]
    );
    await client.query(
      `INSERT INTO payment_subscription_plans
         (id, organization_id, project_id, owner_wallet_id, owner_address,
          puller_wallet_id, puller_address, token, amount, period_hours,
          program_plan_id, plan_pda, status, metadata_uri, created_at, updated_at)
       SELECT fixture.id, $1, $2, fixture.owner_ref, fixture.owner_address,
              fixture.puller_ref, fixture.puller_address, 'USDC', '25.00', 24,
              fixture.id, fixture.id || '_pda', 'archived',
              'https://example.test/retained.json',
              '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
       FROM (VALUES
         ('old', 'owner_ref', 'owner_address', 'puller_ref', 'puller_address'),
         ('ambiguous', 'collision_ref', 'collision_address', 'collision_ref', 'collision_address'),
         ('foreign_org_plan', 'foreign_org_ref', 'foreign_org_address', NULL, NULL),
         ('foreign_project_plan', 'foreign_project_ref', 'foreign_project_address', NULL, NULL),
         ('address_mismatch', 'owner_ref', 'wrong_address', NULL, NULL),
         ('missing_wallet', 'missing_ref', 'missing_address', NULL, NULL),
         ('no_collector', 'owner_ref', 'owner_address', NULL, NULL),
         ('independent_owner', 'owner_ref', 'owner_address', 'puller_ref', 'wrong_address'),
         ('independent_puller', 'owner_ref', 'wrong_address', 'puller_ref', 'puller_address'),
         ('provider_drift', 'saved_old_ref', 'owner_address', NULL, NULL)
       ) AS fixture(id, owner_ref, owner_address, puller_ref, puller_address)`,
      [tenant.organizationId, tenant.projectId]
    );
    await client.query(
      `INSERT INTO payment_subscription_plans
         (id, organization_id, project_id, owner_wallet_id, owner_address,
          token, amount, period_hours, program_plan_id, status)
       VALUES ('other_tenant_plan', $1, $2, 'foreign_org_ref', 'foreign_org_address',
               'USDC', '25.00', 24, 'other_tenant_plan', 'archived')`,
      [otherTenant.organizationId, otherTenant.projectId]
    );
    const plans = async () =>
      (
        await client.query<PaymentSubscriptionPlanRow>(
          "SELECT * FROM payment_subscription_plans ORDER BY id"
        )
      ).rows;
    const before = await plans();
    await client.query(`
      CREATE FUNCTION pr4_backfill_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF to_jsonb(OLD)->>'puller_custody_wallet_id'
           IS DISTINCT FROM to_jsonb(NEW)->>'puller_custody_wallet_id' THEN
          RAISE EXCEPTION 'forced plan puller backfill failure';
        END IF;
        RETURN NEW;
      END;
      $$;
      CREATE TRIGGER pr4_backfill_test_failure
        BEFORE UPDATE ON payment_subscription_plans
        FOR EACH ROW EXECUTE FUNCTION pr4_backfill_test_failure();
    `);
    await expect(runPostgresMigrations({ databaseUrl, migrationsDir })).rejects.toMatchObject({
      code: RAISE_EXCEPTION,
      message: "forced plan puller backfill failure",
    });
    expect(await plans()).toEqual(before);
    expect(
      (
        await client.query<{ version: string }>(
          "SELECT version FROM schema_migrations WHERE version = $1",
          [migration]
        )
      ).rows
    ).toEqual([]);
    expect(
      (
        await client.query<{ indexname: string }>(
          `SELECT indexname FROM pg_indexes
           WHERE schemaname = 'public'
             AND indexname IN ('idx_payment_subscription_plans_owner_custody_wallet',
                               'idx_payment_subscription_plans_puller_custody_wallet')`
        )
      ).rows
    ).toEqual([]);
    await client.query(`
      DROP TRIGGER pr4_backfill_test_failure ON payment_subscription_plans;
      DROP FUNCTION pr4_backfill_test_failure();
    `);
    await runPostgresMigrations({ databaseUrl, migrationsDir });
    const first = await plans();
    const expectedPlanPins = new Map<
      string,
      { owner_custody_wallet_id?: string; puller_custody_wallet_id?: string }
    >([
      ["old", { owner_custody_wallet_id: "owner", puller_custody_wallet_id: "puller" }],
      ["no_collector", { owner_custody_wallet_id: "owner" }],
      ["other_tenant_plan", { owner_custody_wallet_id: "foreign_org_owner" }],
      ["independent_owner", { owner_custody_wallet_id: "owner" }],
      ["independent_puller", { puller_custody_wallet_id: "puller" }],
    ]);
    expect(first).toEqual(
      before.map((plan) => ({
        ...plan,
        owner_custody_wallet_id: null,
        puller_custody_wallet_id: null,
        ...expectedPlanPins.get(plan.id),
      }))
    );

    await client.query(`UPDATE payment_subscription_plans
      SET owner_custody_wallet_id = 'puller', puller_custody_wallet_id = 'owner'
      WHERE id = 'old'`);
    await client.query(`UPDATE payment_subscription_plans
      SET owner_custody_wallet_id = NULL, puller_custody_wallet_id = 'owner'
      WHERE id = 'independent_owner'`);
    await client.query(`UPDATE payment_subscription_plans
      SET owner_custody_wallet_id = 'puller', puller_custody_wallet_id = NULL
      WHERE id = 'independent_puller'`);
    await client.query(`UPDATE payment_subscription_plans
      SET owner_custody_wallet_id = 'owner'
      WHERE id = 'provider_drift'`);
    const beforeCatchup = await plans();
    await runPostgresMigrations({ databaseUrl, migrationsDir });
    expect(await plans()).toEqual(beforeCatchup);
    const catchup = readFileSync(
      path.resolve(migrationsDir, "../../../../scripts/backfill-payments-execution-identity.sql"),
      "utf8"
    );
    const start = catchup.indexOf("-- BEGIN recurring exact identity");
    const end = catchup.indexOf("-- END recurring exact identity", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const recurringCatchup = catchup.slice(start, end).replace(/^\\.*$/gm, "");
    await client.query(recurringCatchup);
    const afterCatchup = await plans();
    expect(afterCatchup).toEqual(
      beforeCatchup.map((plan) => {
        switch (plan.id) {
          case "independent_owner":
            return { ...plan, owner_custody_wallet_id: "owner" };
          case "independent_puller":
            return { ...plan, puller_custody_wallet_id: "puller" };
          default:
            return plan;
        }
      })
    );
    await client.query(recurringCatchup);
    expect(await plans()).toEqual(afterCatchup);
  } finally {
    try {
      await client.query(`
        DROP TRIGGER IF EXISTS pr4_backfill_test_failure ON payment_subscription_plans;
        DROP FUNCTION IF EXISTS pr4_backfill_test_failure();
      `);
      await seedTestDatabase(env);
      await runPostgresMigrations({ databaseUrl, migrationsDir });
    } finally {
      await client.end();
    }
  }
});
