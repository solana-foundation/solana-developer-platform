import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { expect, it } from "vitest";
import { adminDatabaseUrl } from "@/test/helpers/env";

const scriptsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts");

function recurringCatchUpSql(): string {
  const sql = readFileSync(
    path.join(scriptsDir, "backfill-payments-execution-identity.sql"),
    "utf8"
  );
  const marker = "-- BEGIN recurring exact identity";
  const start = sql.indexOf(marker);
  if (start < 0) throw new Error("Missing recurring catch-up section");
  return sql
    .slice(start, sql.indexOf("-- END recurring exact identity", start))
    .replace(/^\\.*$/gm, "");
}

it("catches up only proven plan roles without changing recurring sources or update attempts", async () => {
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
      plan_pda TEXT
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
      authorization_setup_signature TEXT, changed_fields TEXT[]
    )`);
    await client.query(`INSERT INTO custody_configs VALUES
      ('cfg', 'org', 'project', 'active'),
      ('archived', 'org', 'project', 'archived'),
      ('moved', 'org', 'sandbox', 'archived'),
      ('foreign_org', 'other_org', 'project', 'archived');
    INSERT INTO custody_connections VALUES ('connection', 'org', 'project', 'active');
    INSERT INTO custody_wallets VALUES
      ('owner', 'cfg', NULL, 'owner_ref', 'owner_address', 'inactive'),
      ('puller', NULL, 'connection', 'puller_ref', 'puller_address', 'active'),
      ('collision_a', 'cfg', NULL, 'collision_ref', 'collision_address', 'active'),
      ('collision_b', 'archived', NULL, 'collision_ref', 'collision_address', 'inactive'),
      ('replacement', 'archived', NULL, 'replacement_ref', 'replacement_address', 'inactive'),
      ('provider_drift', 'cfg', NULL, 'current_provider_ref', 'drift_address', 'active'),
      ('foreign', 'moved', NULL, 'foreign_ref', 'foreign_address', 'active'),
      ('foreign_org_owner', 'foreign_org', NULL, 'owner_ref', 'owner_address', 'inactive');
    INSERT INTO payment_subscription_plans VALUES
      ('old', 'org', 'project', 'active', 'owner_ref', 'owner_address', NULL,
       'puller_ref', 'puller_address', NULL, 'old_pda'),
      ('new', 'org', 'project', 'active', 'replacement_ref', 'replacement_address', NULL,
       NULL, NULL, NULL, 'new_pda'),
      ('ambiguous', 'org', 'project', 'draft', 'collision_ref', 'collision_address', NULL,
       NULL, NULL, NULL, 'ambiguous_pda'),
      ('foreign_plan', 'org', 'project', 'draft', 'foreign_ref', 'foreign_address', NULL,
       NULL, NULL, NULL, 'foreign_pda'),
      ('stale', 'org', 'project', 'active', 'puller_ref', 'puller_address', 'owner',
       NULL, NULL, NULL, 'stale_pda'),
      ('provider_drift', 'org', 'project', 'active', 'saved_provider_ref', 'drift_address', 'provider_drift',
       NULL, NULL, NULL, 'drift_pda'),
      ('independent_owner', 'org', 'project', 'active', 'owner_ref', 'owner_address', NULL,
       'puller_ref', 'puller_address', 'puller', 'independent_owner_pda'),
      ('independent_puller', 'org', 'project', 'active', 'owner_ref', 'owner_address', 'owner',
       'puller_ref', 'puller_address', NULL, 'independent_puller_pda');
    INSERT INTO payment_recurring_payments VALUES
      ('recurring', 'org', 'project', 'canceled', 'owner_ref', 'owner_address', NULL, 'old', 'sub'),
      ('pinned', 'org', 'project', 'active', 'owner_ref', 'owner_address', 'owner', 'old', 'pinned_sub'),
      ('ambiguous', 'org', 'project', 'active', 'collision_ref', 'collision_address', NULL, 'ambiguous', NULL),
      ('foreign', 'org', 'project', 'paused', 'foreign_ref', 'foreign_address', NULL, 'foreign_plan', NULL);
    INSERT INTO payment_recurring_payment_update_attempts VALUES
      ('replacement', 'org', 'project', 'processing', 'replacement', 'authorize_subscription',
       'recurring', NULL, 'old', 'new', '{}', '{}', 'saved_setup', ARRAY['sourceCustodyWalletId']),
      ('unresolved', 'org', 'project', 'processing', 'replacement', 'create_plan',
       'recurring', NULL, 'old', NULL, '{}', '{}', NULL, ARRAY['sourceCustodyWalletId']),
      ('stale_attempt', 'org', 'project', 'processing', 'replacement', 'authorize_subscription',
       'recurring', 'owner', 'old', 'new', '{}', '{}', 'retained_signature', ARRAY['sourceCustodyWalletId']),
      ('conflicting_snapshot', 'org', 'project', 'processing', 'replacement', 'create_plan',
       'recurring', NULL, 'old', 'new', '{}', '{"sourceCustodyWalletId":"owner"}', NULL, ARRAY['sourceCustodyWalletId']),
      ('amount_only', 'org', 'project', 'processing', 'replacement', 'create_plan',
       'pinned', NULL, 'old', 'old', '{"amount":"100","sourceCustodyWalletId":"owner"}',
       '{"amount":"250","sourceCustodyWalletId":"owner"}', NULL, ARRAY['amount'])`);

    const snapshot = async () => ({
      plans: (await client.query("SELECT * FROM payment_subscription_plans ORDER BY id")).rows,
      recurring: (await client.query("SELECT * FROM payment_recurring_payments ORDER BY id")).rows,
      attempts: (
        await client.query("SELECT * FROM payment_recurring_payment_update_attempts ORDER BY id")
      ).rows,
    });
    const before = await snapshot();
    const catchup = recurringCatchUpSql();
    await client.query(catchup);
    const first = await snapshot();
    const expectedPlanPins = new Map<
      string,
      { owner_custody_wallet_id?: string; puller_custody_wallet_id?: string }
    >([
      ["old", { owner_custody_wallet_id: "owner", puller_custody_wallet_id: "puller" }],
      ["new", { owner_custody_wallet_id: "replacement" }],
      ["independent_owner", { owner_custody_wallet_id: "owner" }],
      ["independent_puller", { puller_custody_wallet_id: "puller" }],
    ]);
    expect(first).toEqual({
      plans: before.plans.map((plan) => ({ ...plan, ...expectedPlanPins.get(plan.id) })),
      recurring: before.recurring,
      attempts: before.attempts,
    });
    await client.query(catchup);
    expect(await snapshot()).toEqual(first);
  } finally {
    await client.end();
  }
});
