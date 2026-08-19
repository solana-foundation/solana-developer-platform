/**
 * Postgres test database helpers.
 *
 * The historical filename is kept so existing imports do not need to move
 * during the cutover branch.
 */

import { getDb } from "@/db";
import { createKVStoreSet, getRedisClient } from "@/runtime/kv-redis";
import {
  AUDIT_LEDGER_CHECKPOINT_KEY,
  AUDIT_LEDGER_SESSION_LOCK_KEY,
} from "@/services/audit.service";
import type { Env } from "@/types/env";

// FK-dependency ordered: dependents before the rows they point at.
//
// The Earn vocabulary tables (earn_execution_models, earn_movement_directions,
// earn_movement_statuses) are deliberately ABSENT. They are seeded reference data
// from migration 0062, not tenant state — truncating them would make every
// subsequent movement insert fail its status foreign key. Nothing here is
// referenced BY them, so CASCADE cannot reach them either.
const POSTGRES_TEST_TABLES = [
  "earn_movements",
  "earn_positions",
  "earn_vault_movements",
  "earn_vault_positions",
  "sponsorship_budget_policy_revisions",
  "sponsorship_budget_reservations",
  "sponsorship_budget_policies",
  "earn_program_withdrawals",
  "earn_provider_wallets",
  "earn_strategies",
  "policy_provider_sync_status",
  "policy_evaluations",
  "approval_requests",
  "approval_group_members",
  "approval_groups",
  "wallet_operations",
  "api_key_wallet_policy_bindings",
  "api_key_control_profile_revisions",
  "api_key_control_profiles",
  "wallet_control_profile_revisions",
  "wallet_control_profiles",
  "api_key_wallet_permissions",
  "custody_scope_defaults",
  "custody_connections",
  "provider_credentials",
  "custody_wallets",
  "signing_requests",
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
  "magic_links",
  "sessions",
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
