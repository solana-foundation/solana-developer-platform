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

it("keeps unfinished legacy messages and unknown accounting visible independently of canceled parents", async () => {
  const client = new Client({ connectionString: adminDatabaseUrl });
  await client.connect();
  try {
    await client.query(`CREATE TEMP TABLE payment_recurring_payments (
      id TEXT, organization_id TEXT, project_id TEXT, source_custody_wallet_id TEXT,
      subscription_id TEXT, status TEXT
    );
    CREATE TEMP TABLE payment_subscription_plans (id TEXT, organization_id TEXT, project_id TEXT, owner_custody_wallet_id TEXT, puller_custody_wallet_id TEXT, puller_wallet_id TEXT, puller_address TEXT);
    CREATE TEMP TABLE payment_subscriptions (id TEXT, organization_id TEXT, project_id TEXT, plan_id TEXT);
    CREATE TEMP TABLE payment_recurring_payment_activation_attempts (
      id TEXT, organization_id TEXT, project_id TEXT, recurring_payment_id TEXT,
      status TEXT, stage TEXT, plan_creation_signature TEXT, authorization_signature TEXT, metadata JSONB
    );
    CREATE TEMP TABLE payment_recurring_payment_lifecycle_attempts (
      id TEXT, organization_id TEXT, project_id TEXT, recurring_payment_id TEXT,
      status TEXT, stage TEXT, operation TEXT, signature TEXT
    );
    CREATE TEMP TABLE payment_recurring_payment_update_attempts (
      id TEXT, organization_id TEXT, project_id TEXT, recurring_payment_id TEXT,
      status TEXT, stage TEXT, mode TEXT, old_plan_id TEXT, new_plan_id TEXT, old_subscription_id TEXT, new_subscription_id TEXT,
      new_source_custody_wallet_id TEXT, before_values JSONB, after_values JSONB,
      plan_update_signature TEXT, plan_creation_signature TEXT, authorization_setup_signature TEXT,
      authorization_signature TEXT, old_cancel_signature TEXT
    );
    CREATE TEMP TABLE payment_subscription_collection_attempts (
      id TEXT, organization_id TEXT, project_id TEXT, subscription_id TEXT,
      status TEXT, due_at TEXT, signature TEXT, metadata JSONB
    );
    CREATE TEMP TABLE payment_recurring_sponsorship_links (
      recurring_payment_id TEXT, organization_id TEXT, project_id TEXT,
      attempt_kind TEXT, attempt_id TEXT, message_key TEXT, deployment_mode TEXT,
      custody_wallet_id TEXT, legacy_actor_id TEXT, reservation_id TEXT, accounting_identity JSONB,
      admission_started_at TIMESTAMPTZ, confirmed_failure_signature TEXT, submission_signature TEXT
    );
    CREATE TEMP TABLE sponsorship_budget_reservations (
      id TEXT, organization_id TEXT, project_id TEXT, network TEXT, product_environment TEXT,
      actor_type TEXT, actor_id TEXT, attempt INTEGER, transaction_digest TEXT, fee_payer TEXT,
      provider_config_fingerprint TEXT, status TEXT, signature TEXT
    );
    INSERT INTO payment_recurring_payments VALUES ('parent', 'org', 'project', 'source', 'sub', 'canceled');
    INSERT INTO payment_recurring_payment_activation_attempts VALUES
      ('legacy', 'org', 'project', 'parent', 'processing', 'authorize_subscription', 'saved_plan', NULL, '{}'),
      ('known', 'org', 'project', 'parent', 'processing', 'authorize_subscription', 'saved_plan', NULL, '{}');
    INSERT INTO payment_subscription_plans VALUES ('old_plan', 'org', 'project', 'old_source', NULL, NULL, NULL);
    INSERT INTO payment_subscriptions VALUES ('old_sub', 'org', 'project', 'old_plan');
    INSERT INTO payment_recurring_payment_update_attempts
      (id, organization_id, project_id, recurring_payment_id, status, mode, old_subscription_id, old_plan_id, before_values)
      VALUES ('old_update', 'org', 'project', 'parent', 'confirmed', 'metadata_schedule', 'old_sub', 'old_plan', '{}');
    INSERT INTO payment_subscription_collection_attempts VALUES
      ('old_cycle', 'org', 'project', 'old_sub', 'processing', '2026-10-12T00:00:00Z', 'saved_collection', '{}');
    INSERT INTO payment_recurring_sponsorship_links VALUES
      ('parent', 'org', 'project', 'collection', 'old_cycle', 'collect', 'self_hosted', 'old_source', 'old_provider', NULL, NULL);
    INSERT INTO sponsorship_budget_reservations VALUES
      ('reservation', 'org', 'project', 'devnet', 'sandbox', 'wallet', 'legacy_provider', 1, 'digest', 'payer', 'fingerprint', 'charged_unknown')`);
    const identity = {
      reservationId: "reservation",
      organizationId: "org",
      projectId: "project",
      network: "devnet",
      environment: "sandbox",
      actor: { type: "wallet", id: "legacy_provider" },
      attempt: 1,
      transactionDigest: "digest",
      feePayer: "payer",
      providerConfigFingerprint: "fingerprint",
    };
    await client.query(
      `INSERT INTO payment_recurring_sponsorship_links VALUES
      ('parent', 'org', 'project', 'activation', 'known', 'create_plan', 'managed', 'source', 'legacy_provider', 'reservation', $1),
      ('parent', 'org', 'project', 'activation', 'known', 'authorize_subscription', 'managed', 'source', 'legacy_provider', 'reservation', $2),
      ('parent', 'org', 'project', 'activation', 'known', 'authorization_setup', 'self_hosted', 'source', 'legacy_provider', NULL, NULL)`,
      [
        JSON.stringify(identity),
        JSON.stringify({ ...identity, actor: { type: "wallet", id: "wrong_actor" } }),
      ]
    );
    await client.query(`INSERT INTO payment_recurring_payment_activation_attempts VALUES
      ('historical_activation','org','project','parent','confirmed','finalize','old_plan_signature','old_authorization','{}');
      INSERT INTO payment_recurring_payment_lifecycle_attempts VALUES
      ('historical_cancel','org','project','parent','confirmed','finalize','cancel','old_cancel_signature');
      INSERT INTO payment_recurring_sponsorship_links VALUES
      ('parent','org','project','activation','historical_activation','create_plan','self_hosted','old_source','old_provider',NULL,NULL),
      ('parent','org','project','activation','historical_activation','authorization_setup','self_hosted','old_source','old_provider',NULL,NULL),
      ('parent','org','project','activation','historical_activation','authorize_subscription','self_hosted','old_source','old_provider',NULL,NULL),
      ('parent','org','project','lifecycle','historical_cancel','cancel','self_hosted','old_source','old_provider',NULL,NULL)`);
    await client.query(`INSERT INTO payment_recurring_payment_activation_attempts VALUES
      ('admission_gap','org','project','parent','processing','create_plan',NULL,NULL,'{}');
      INSERT INTO payment_recurring_sponsorship_links
      (recurring_payment_id,organization_id,project_id,attempt_kind,attempt_id,message_key,
       deployment_mode,custody_wallet_id,legacy_actor_id,admission_started_at)
      VALUES ('parent','org','project','activation','admission_gap','create_plan',
      'managed','source','legacy_provider','2026-10-12T00:00:00Z')`);
    await client.query(`UPDATE payment_recurring_sponsorship_links
      SET confirmed_failure_signature='failed_setup',submission_signature='failed_setup'
      WHERE attempt_id='historical_activation' AND message_key='authorization_setup';
      INSERT INTO payment_recurring_sponsorship_links
      (recurring_payment_id,organization_id,project_id,attempt_kind,attempt_id,message_key,
       deployment_mode,custody_wallet_id,legacy_actor_id)
      VALUES ('parent','org','project','activation','historical_activation','authorization_setup:failed_setup',
              'self_hosted','old_source','old_provider'),
             ('parent','org','project','activation','historical_activation','authorization_setup:unproven',
              'self_hosted','old_source','old_provider')`);
    const sql = readFileSync(
      path.join(scriptsDir, "audit-payments-execution-identity.sql"),
      "utf8"
    );
    const marker = "-- BEGIN recurring accounting readiness";
    const start = sql.indexOf(marker);
    if (start < 0) throw new Error("Missing recurring accounting readiness audit");
    const audit = await client.query(
      sql
        .slice(start, sql.indexOf("-- END recurring accounting readiness", start))
        .replace(/^\\.*$/gm, "")
    );
    expect(audit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt_id: "admission_gap",
          message_key: "create_plan",
          classification: "started_without_accounting",
        }),
        expect.objectContaining({
          attempt_id: "legacy",
          message_key: "create_plan",
          classification: "missing_linkage",
        }),
        expect.objectContaining({
          attempt_id: "legacy",
          message_key: "authorization_setup",
          classification: "missing_linkage",
        }),
        expect.objectContaining({
          attempt_id: "known",
          message_key: "authorize_subscription",
          classification: "inconsistent_accounting",
        }),
        expect.objectContaining({
          attempt_id: "known",
          message_key: "create_plan",
          reservation_status: "charged_unknown",
        }),
        expect.objectContaining({
          attempt_id: "known",
          message_key: "authorization_setup",
          classification: "mode_conflict",
        }),
        expect.objectContaining({
          attempt_id: "old_cycle",
          message_key: "collect",
          expected_wallet_id: "old_source",
          classification: "self_hosted_evidence",
        }),
      ])
    );
    expect(audit.rows.filter((row) => row.attempt_id.startsWith("historical_"))).toHaveLength(6);
    expect(audit.rows.filter((row) => row.attempt_id.startsWith("historical_"))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          attempt_id: "historical_activation",
          custody_wallet_id: "old_source",
          expected_wallet_id: null,
          classification: "historical_self_hosted_evidence",
        }),
        expect.objectContaining({
          attempt_id: "historical_activation",
          message_key: "authorization_setup:failed_setup",
          classification: "historical_self_hosted_evidence",
        }),
        expect.objectContaining({
          attempt_id: "historical_activation",
          message_key: "authorization_setup:unproven",
          classification: "inconsistent_retry_evidence",
        }),
        expect.objectContaining({
          attempt_id: "historical_cancel",
          custody_wallet_id: "old_source",
          expected_wallet_id: null,
          classification: "historical_self_hosted_evidence",
        }),
      ])
    );
  } finally {
    await client.end();
  }
});
