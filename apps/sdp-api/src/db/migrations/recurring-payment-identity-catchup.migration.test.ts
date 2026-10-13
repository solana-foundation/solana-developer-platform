import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts");

function recurringSection(file: string): string {
  const sql = readFileSync(path.join(scriptsDir, file), "utf8");
  const marker = "-- BEGIN recurring exact identity";
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error(`Missing recurring audit/catch-up section in ${file}`);
  return sql
    .slice(start, sql.indexOf("-- END recurring exact identity", start))
    .replace(/^\\.*$/gm, "");
}

it("audits and catches up only proven retained recurring roles without rebinding history", async () => {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE custody_configs (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT, status TEXT
    );
    CREATE TEMP TABLE custody_connections (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT, status TEXT
    );
    CREATE TEMP TABLE custody_wallets (
      id TEXT PRIMARY KEY, custody_config_id TEXT, custody_connection_id TEXT,
      wallet_id TEXT, public_key TEXT, status TEXT
    );
    CREATE TEMP TABLE payment_subscription_plans (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT, status TEXT,
      owner_wallet_id TEXT, owner_address TEXT, owner_custody_wallet_id TEXT,
      puller_wallet_id TEXT, puller_address TEXT, puller_custody_wallet_id TEXT,
      role_projection_revision BIGINT NOT NULL DEFAULT 0, plan_pda TEXT
    );
    CREATE TEMP TABLE payment_recurring_payments (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT, status TEXT,
      source_wallet_id TEXT, source_address TEXT, source_custody_wallet_id TEXT,
      plan_id TEXT, subscription_id TEXT
    );
    CREATE TEMP TABLE payment_recurring_payment_update_attempts (
      id TEXT PRIMARY KEY, organization_id TEXT, project_id TEXT, status TEXT,
      mode TEXT, stage TEXT, recurring_payment_id TEXT, new_source_custody_wallet_id TEXT,
      old_plan_id TEXT, new_plan_id TEXT, before_values JSONB, after_values JSONB,
      authorization_setup_signature TEXT
    )`);
    await client.query(`INSERT INTO custody_configs VALUES
      ('cfg', 'org', 'project', 'active'),
      ('archived', 'org', 'project', 'archived'),
      ('moved', 'org', 'sandbox', 'archived');
    INSERT INTO custody_connections VALUES ('connection', 'org', 'project', 'active');
    INSERT INTO custody_wallets VALUES
      ('owner', 'cfg', NULL, 'owner_ref', 'owner_address', 'inactive'),
      ('puller', NULL, 'connection', 'puller_ref', 'puller_address', 'active'),
      ('collision_a', 'cfg', NULL, 'collision_ref', 'collision_address', 'active'),
      ('collision_b', 'archived', NULL, 'collision_ref', 'collision_address', 'inactive'),
      ('replacement', 'archived', NULL, 'replacement_ref', 'replacement_address', 'inactive'),
      ('provider_drift', 'cfg', NULL, 'current_provider_ref', 'drift_address', 'active'),
      ('foreign', 'moved', NULL, 'foreign_ref', 'foreign_address', 'active');
    INSERT INTO payment_subscription_plans VALUES
      ('old', 'org', 'project', 'active', 'owner_ref', 'owner_address', NULL,
       'puller_ref', 'puller_address', NULL, 0, 'old_pda'),
      ('new', 'org', 'project', 'active', 'replacement_ref', 'replacement_address', NULL,
       NULL, NULL, NULL, 0, 'new_pda'),
      ('ambiguous', 'org', 'project', 'draft', 'collision_ref', 'collision_address', NULL,
       NULL, NULL, NULL, 0, 'ambiguous_pda'),
      ('foreign_plan', 'org', 'project', 'draft', 'foreign_ref', 'foreign_address', NULL,
       NULL, NULL, NULL, 0, 'foreign_pda'),
      ('stale', 'org', 'project', 'active', 'puller_ref', 'puller_address', 'owner',
       NULL, NULL, NULL, 1, 'stale_pda'),
      ('provider_drift', 'org', 'project', 'active', 'saved_provider_ref', 'drift_address', 'provider_drift',
       NULL, NULL, NULL, 1, 'drift_pda'),
      ('unfenced', 'org', 'project', 'active', 'owner_ref', 'owner_address', 'owner',
       'puller_ref', 'puller_address', NULL, 0, 'unfenced_pda');
    INSERT INTO payment_recurring_payments VALUES
      ('recurring', 'org', 'project', 'canceled', 'owner_ref', 'owner_address', NULL, 'old', 'sub'),
      ('ambiguous', 'org', 'project', 'active', 'collision_ref', 'collision_address', NULL, 'ambiguous', NULL),
      ('foreign', 'org', 'project', 'paused', 'foreign_ref', 'foreign_address', NULL, 'foreign_plan', NULL);
    INSERT INTO payment_recurring_payment_update_attempts VALUES
      ('replacement', 'org', 'project', 'processing', 'replacement', 'authorize_subscription',
       'recurring', NULL, 'old', 'new', '{}', '{}', 'saved_setup'),
      ('unresolved', 'org', 'project', 'processing', 'replacement', 'create_plan',
       'recurring', NULL, 'old', NULL, '{}', '{}', NULL),
      ('stale_attempt', 'org', 'project', 'processing', 'replacement', 'authorize_subscription',
       'recurring', 'owner', 'old', 'new', '{}', '{}', 'retained_signature')`);

    const beforeAudit = await client.query(
      recurringSection("audit-payments-execution-identity.sql")
    );
    expect(beforeAudit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "plan_owner",
          id: "old",
          classification: "resolvable_unique",
        }),
        expect.objectContaining({
          resource: "plan_puller",
          id: "new",
          classification: "absent_optional_role",
        }),
        expect.objectContaining({
          resource: "plan_owner",
          id: "ambiguous",
          classification: "ambiguous_multi",
        }),
        expect.objectContaining({
          resource: "plan_owner",
          id: "foreign_plan",
          classification: "unresolved_zero",
        }),
        expect.objectContaining({
          resource: "plan_owner",
          id: "stale",
          classification: "inconsistent_pin",
        }),
        expect.objectContaining({
          resource: "plan_owner",
          id: "provider_drift",
          provider_wallet_id: "saved_provider_ref",
          match_count: 0,
          classification: "exact_pin",
        }),
        expect.objectContaining({
          resource: "plan_owner",
          id: "unfenced",
          classification: "unfenced_pin",
        }),
        expect.objectContaining({
          resource: "replacement_source",
          id: "stale_attempt",
          classification: "inconsistent_pin",
        }),
        expect.objectContaining({
          resource: "replacement_source",
          id: "unresolved",
          classification: "unresolved_zero",
        }),
        expect.objectContaining({
          resource: "replacement_old_plan_owner",
          id: "replacement",
          classification: "resolvable_unique",
        }),
        expect.objectContaining({
          resource: "replacement_new_plan_owner",
          id: "unresolved",
          classification: "unresolved_zero",
        }),
      ])
    );

    const catchup = recurringSection("backfill-payments-execution-identity.sql");
    await client.query(catchup);
    const snapshot = async () => ({
      plans: (await client.query("SELECT * FROM payment_subscription_plans ORDER BY id")).rows,
      recurring: (await client.query("SELECT * FROM payment_recurring_payments ORDER BY id")).rows,
      attempts: (
        await client.query("SELECT * FROM payment_recurring_payment_update_attempts ORDER BY id")
      ).rows,
    });
    const first = await snapshot();
    expect(first.plans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "old",
          owner_custody_wallet_id: "owner",
          puller_custody_wallet_id: "puller",
          plan_pda: "old_pda",
        }),
        expect.objectContaining({
          id: "new",
          owner_custody_wallet_id: "replacement",
          puller_custody_wallet_id: null,
          plan_pda: "new_pda",
        }),
        expect.objectContaining({ id: "stale", owner_custody_wallet_id: "owner" }),
        expect.objectContaining({
          id: "unfenced",
          owner_custody_wallet_id: "owner",
          puller_custody_wallet_id: null,
          role_projection_revision: 0,
        }),
        expect.objectContaining({ id: "ambiguous", owner_custody_wallet_id: null }),
        expect.objectContaining({ id: "foreign_plan", owner_custody_wallet_id: null }),
      ])
    );
    expect(first.recurring).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "recurring",
          source_custody_wallet_id: "owner",
          status: "canceled",
        }),
        expect.objectContaining({ id: "ambiguous", source_custody_wallet_id: null }),
        expect.objectContaining({ id: "foreign", source_custody_wallet_id: null }),
      ])
    );
    expect(first.attempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "replacement",
          new_source_custody_wallet_id: "replacement",
          old_plan_id: "old",
          new_plan_id: "new",
          authorization_setup_signature: "saved_setup",
        }),
        expect.objectContaining({ id: "unresolved", new_source_custody_wallet_id: null }),
        expect.objectContaining({
          id: "stale_attempt",
          new_source_custody_wallet_id: "owner",
          authorization_setup_signature: "retained_signature",
        }),
      ])
    );
    await client.query(catchup);
    expect(await snapshot()).toEqual(first);
    const afterAudit = await client.query(
      recurringSection("audit-payments-execution-identity.sql")
    );
    expect(afterAudit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          resource: "replacement_source",
          id: "replacement",
          classification: "exact_pin",
        }),
        expect.objectContaining({
          resource: "plan_owner",
          id: "stale",
          classification: "inconsistent_pin",
        }),
        expect.objectContaining({
          resource: "plan_owner",
          id: "unfenced",
          classification: "unfenced_pin",
        }),
      ])
    );
  } finally {
    await client.end();
  }
});
