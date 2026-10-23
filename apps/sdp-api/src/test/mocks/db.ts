/**
 * Postgres test database helpers.
 *
 * The historical filename is kept so existing imports do not need to move
 * during the cutover branch.
 */

import type { Action } from "@sdp/types/actions";
import type {
  ApiKeyEnvironment,
  ApiKeyStatus,
  ApiKeyWalletScope,
  RateLimitTier,
} from "@sdp/types/api-keys";
import { getDb } from "@/db/client";
import { resetTerminalRefusalsForTesting } from "@/lib/api-key-refusal-cache";
import { createKVStoreSet, getRedisClient } from "@/runtime/kv-redis";
import {
  AUDIT_LEDGER_CHECKPOINT_KEY,
  AUDIT_LEDGER_SESSION_LOCK_KEY,
} from "@/services/audit.service";
import { DEFAULT_PROJECT_NAME, DEFAULT_PROJECT_SLUG } from "@/test/helpers/projects";
import type { Env } from "@/types/env";

// FK-dependency ordered: dependents before the rows they point at.
//
// The Earn vocabulary tables (earn_execution_models, earn_movement_directions,
// earn_movement_statuses) are deliberately ABSENT. They are seeded reference data
// from migration 0062, not tenant state — truncating them would make every
// subsequent movement insert fail its status foreign key. Nothing here is
// referenced BY them, so CASCADE cannot reach them either.
const POSTGRES_TEST_TABLES = [
  "ramp_webhook_events",
  "moonpay_failed_transactions",
  "earn_vault_withdrawal_request_pda_leases",
  "earn_external_wallet_withdrawal_request_transactions",
  "earn_vault_withdrawal_request_actions",
  "earn_vault_withdrawal_request_reservations",
  "earn_vault_withdrawal_requests",
  "earn_movements",
  "earn_positions",
  "sponsorship_budget_policy_revisions",
  "sponsorship_budget_reservations",
  "sponsorship_budget_policies",
  "earn_provider_wallets",
  "earn_strategies",
  "api_key_signing_wallets",
  "custody_connections",
  "provider_credentials",
  "secret_retirements",
  "fireblocks_csr_requests",
  "custody_wallets",
  "custody_configs",
  "payment_recurring_payment_update_events",
  "payment_recurring_payment_update_attempts",
  "payment_recurring_payment_lifecycle_attempts",
  "payment_recurring_payment_activation_attempts",
  "payment_subscription_collection_attempts",
  "payment_recurring_payments",
  "payment_subscriptions",
  "payment_subscription_plans",
  "payment_requests",
  "payment_transfer_recipients",
  "payment_transfer_batches",
  "payment_transfers",
  "frozen_accounts",
  "token_allowlist_statuses",
  "token_allowlists",
  "issuance_transaction_statuses",
  "issuance_transactions",
  "issued_token_extensions",
  "issued_tokens",
  "counterparty_accounts",
  "counterparties",
  "private_channel_verified_wallets",
  "private_channel_memberships",
  "private_channel_users",
  "private_channel_events",
  "private_channel_withdrawals",
  "private_channel_deposits",
  "private_channels",
  "private_channel_instances",
  "helius_rings_events",
  "helius_rings_timelocks",
  "helius_rings_operations",
  "helius_rings_connections",
  "helius_rings_zones",
  "helius_rings_wallets",
  "helius_rings_runtime_health",
  // helius_rings_asset_allowlist is deliberately absent: it is platform
  // reference data seeded by migration 0057, not per-test state. Truncating it
  // would empty it for the rest of the run, and nothing re-seeds it.
  "project_members",
  "api_keys",
  "projects",
  "invitations",
  "audit_ledger_anchors",
  "audit_logs",
  "auth_organization_identities",
  "auth_user_identities",
  "organization_members",
  "users",
  "organizations",
  "allowlist",
] as const;

async function seedSponsorshipBudgetPolicies(env: Env): Promise<void> {
  const db = getDb(env);
  await db.execute(
    `INSERT INTO sponsorship_budget_policies (
       id, network, scope_type, scope_id, enabled,
       per_transaction_lamports, hourly_lamports, daily_lamports,
       version, updated_by, update_reason
     ) VALUES
       ('sbp_devnet_global', 'devnet', 'global', NULL, TRUE, 10000000, 2000000000, 10000000000, 1, 'test-seed', 'Reset devnet sponsorship controls'),
       ('sbp_devnet_org_default', 'devnet', 'organization', NULL, TRUE, 10000000, 1000000000, 5000000000, 1, 'test-seed', 'Reset devnet organization default'),
       ('sbp_devnet_project_default', 'devnet', 'project', NULL, TRUE, 10000000, 1000000000, 3000000000, 1, 'test-seed', 'Reset devnet project default'),
       ('sbp_mainnet_global', 'mainnet', 'global', NULL, FALSE, 10000000, 500000000, 1000000000, 1, 'test-seed', 'Reset mainnet sponsorship controls'),
       ('sbp_mainnet_org_default', 'mainnet', 'organization', NULL, TRUE, 10000000, 250000000, 500000000, 1, 'test-seed', 'Reset mainnet organization default'),
       ('sbp_mainnet_project_default', 'mainnet', 'project', NULL, TRUE, 10000000, 100000000, 250000000, 1, 'test-seed', 'Reset mainnet project default')`
  );
  await db.execute(
    `INSERT INTO sponsorship_budget_policy_revisions (
       id, policy_id, network, scope_type, scope_id, enabled,
       per_transaction_lamports, hourly_lamports, daily_lamports,
       version, changed_by, change_reason
     )
     SELECT 'sbpr_' || id || '_1', id, network, scope_type, scope_id, enabled,
            per_transaction_lamports, hourly_lamports, daily_lamports,
            version, updated_by, update_reason
     FROM sponsorship_budget_policies`
  );
}

/**
 * Resets this worker's database to empty by truncating every test table.
 * Call from beforeEach; there is deliberately no afterEach counterpart —
 * the next test's reset makes trailing cleanup a redundant round trip.
 *
 * @param env - Test environment bindings for this worker's database.
 * @returns Resolves once every table is truncated.
 */
export async function seedTestDatabase(env: Env): Promise<void> {
  const db = getDb(env);

  try {
    // Serialize the reset with in-flight audit-ledger writers. TRUNCATE already
    // waits for their transactions via its ACCESS EXCLUSIVE lock, but the
    // checkpoint delete talks to Redis and would otherwise land between a
    // writer's pre-commit witness and its post-commit advance, failing that
    // write with "checkpoint did not advance" in whichever test runs next.
    const lockedTransactionWithPostCommit = db.lockedTransactionWithPostCommit?.bind(db);
    if (!lockedTransactionWithPostCommit) {
      throw new Error("Test database client cannot serialize the audit-ledger reset");
    }
    await lockedTransactionWithPostCommit(
      AUDIT_LEDGER_SESSION_LOCK_KEY,
      async (tx) => {
        await tx.execute(
          `TRUNCATE TABLE ${POSTGRES_TEST_TABLES.join(", ")} RESTART IDENTITY CASCADE`
        );
      },
      async () => {
        await createKVStoreSet(env).cache.delete(AUDIT_LEDGER_CHECKPOINT_KEY);
      }
    );
    const redis = await getRedisClient(env);
    const sponsorshipKeys = await redis.keys("sdp:sponsorship:*");
    if (sponsorshipKeys.length > 0) {
      await redis.del(...sponsorshipKeys);
    }
  } catch (error) {
    throw new Error(
      "Postgres schema is not bootstrapped. Run `pnpm infra:up` and `pnpm --filter @sdp/api db:postgres:bootstrap` first.",
      {
        cause: error,
      }
    );
  }

  await seedSponsorshipBudgetPolicies(env);
}

/**
 * The state of an API key a suite seeds: the `api_keys` columns authentication
 * reads, plus the signing wallets to list. Authentication reads all of it from
 * Postgres on every request, so this is exactly what a request sees.
 */
export interface SeededApiKey {
  id: string;
  organizationId: string;
  projectId: string;
  /** The key's explicit grants (`api_keys.grants`). */
  grants: readonly Action[];
  environment: ApiKeyEnvironment;
  rateLimitTier: RateLimitTier;
  allowedIps: string[] | null;
  /** `api_keys.wallet_scope`; `all` unless the seed names a scope or wallets. */
  walletScope?: ApiKeyWalletScope;
  /**
   * Custody wallet ids (`custody_wallets.id`) a `selected` key lists. Naming
   * them makes the key `selected` and replaces its list; the wallets must
   * already exist (the list has a foreign key).
   */
  walletIds?: string[];
  status: ApiKeyStatus;
  expiresAt: string | null;
  rotationDeadline?: string | null;
  /** Ignored: authentication reads the organization row's own status. */
  organizationStatus?: string;
}

/** Creates the user a seeded key row needs when the suite has none. */
const SEEDED_KEY_CREATOR_ID = "usr_seeded_key_creator";

/**
 * Writes the `api_keys` row for a seeded key, inserting it or overwriting the
 * columns authentication reads, so a second seed of the same key changes what
 * its next request sees. The key joins `projectId` when the organization has
 * it; otherwise the organization's active project in the key's environment
 * (one per environment), which is created as `projectId`, with the default
 * project's name and slug, when there is none.
 * Skipped when the organization does not exist.
 */
export async function seedApiKeyRow(env: Env, keyHash: string, data: SeededApiKey): Promise<void> {
  // A seed can bring a refused key back to life within a test; the
  // instance's refusal cache must not outlive that.
  resetTerminalRefusalsForTesting();
  const db = getDb(env);
  await db
    .prepare(
      `INSERT INTO users (id, email, email_verified, status)
       SELECT ?, 'seeded-key-creator@example.test', 1, 'active'
        WHERE NOT EXISTS (SELECT 1 FROM users)
       ON CONFLICT DO NOTHING`
    )
    .bind(SEEDED_KEY_CREATOR_ID)
    .run();
  await db
    .prepare(
      `INSERT INTO projects (id, organization_id, name, slug, environment, status, created_by)
       SELECT ?, o.id, ?, ?, ?, 'active',
              (SELECT id FROM users ORDER BY id LIMIT 1)
         FROM organizations o
        WHERE o.id = ?
          AND NOT EXISTS (
            SELECT 1 FROM projects
             WHERE organization_id = o.id AND environment = ? AND status = 'active'
          )
       ON CONFLICT DO NOTHING`
    )
    .bind(
      data.projectId,
      DEFAULT_PROJECT_NAME[data.environment],
      DEFAULT_PROJECT_SLUG[data.environment],
      data.environment,
      data.organizationId,
      data.environment
    )
    .run();
  await db
    .prepare(
      `INSERT INTO api_keys
         (id, organization_id, project_id, created_by, name, key_prefix, key_hash,
          grants, status, expires_at, rotation_deadline, wallet_scope,
          allowed_ips, rate_limit_tier)
       SELECT ?, p.organization_id, p.id, (SELECT id FROM users ORDER BY id LIMIT 1),
              'Seeded test key', 'sk_test', ?, ?, ?, ?, ?, ?, ?, ?
         FROM projects p
        WHERE p.organization_id = ?
          AND (p.id = ? OR (p.environment = ? AND p.status = 'active'))
        ORDER BY (p.id = ?) DESC
        LIMIT 1
       ON CONFLICT (id) DO UPDATE SET
         key_hash = EXCLUDED.key_hash,
         grants = EXCLUDED.grants,
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         rotation_deadline = EXCLUDED.rotation_deadline,
         wallet_scope = EXCLUDED.wallet_scope,
         allowed_ips = EXCLUDED.allowed_ips,
         rate_limit_tier = EXCLUDED.rate_limit_tier`
    )
    .bind(
      data.id,
      keyHash,
      [...data.grants],
      data.status,
      data.expiresAt,
      data.rotationDeadline ?? null,
      data.walletScope ?? (data.walletIds === undefined ? "all" : "selected"),
      data.allowedIps === null ? null : JSON.stringify(data.allowedIps),
      data.rateLimitTier,
      data.organizationId,
      data.projectId,
      data.environment,
      data.projectId
    )
    .run();

  // The signing list lives in its own table: a seed that names wallets
  // replaces the key's rows with them. One that names none leaves rows a test
  // inserted itself.
  if (data.walletIds === undefined) {
    return;
  }
  const walletIds = data.walletIds;
  // One replacement: a failed insert must not leave the key partly listed.
  await db.transaction(async (tx) => {
    await tx.execute(
      `UPDATE api_key_signing_wallets
          SET status = 'archived', archived_at = sdp_iso_now()
        WHERE api_key_id = ? AND status = 'active' AND NOT (custody_wallet_id = ANY(?::text[]))`,
      [data.id, walletIds]
    );
    await tx.execute(
      `INSERT INTO api_key_signing_wallets (api_key_id, custody_wallet_id)
       SELECT ak.id, w FROM api_keys ak CROSS JOIN unnest(?::text[]) AS w WHERE ak.id = ?
       ON CONFLICT (api_key_id, custody_wallet_id) DO UPDATE
         SET status = 'active', archived_at = NULL
       WHERE api_key_signing_wallets.status = 'archived'`,
      [walletIds, data.id]
    );
  });
}
