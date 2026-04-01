/**
 * Postgres test database helpers.
 *
 * The historical filename is kept so existing imports do not need to move
 * during the cutover branch.
 */

import { getDb } from "@/db";
import type { Env } from "@/types/env";

const POSTGRES_TEST_TABLES = [
  "api_key_wallet_permissions",
  "custody_scope_defaults",
  "custody_wallets",
  "signing_requests",
  "custody_configs",
  "payment_transfers",
  "payment_wallet_policies",
  "frozen_accounts",
  "token_allowlist_statuses",
  "token_allowlists",
  "issuance_transaction_statuses",
  "issuance_transactions",
  "issued_token_extensions",
  "issued_tokens",
  "magic_links",
  "sessions",
  "project_members",
  "api_keys",
  "projects",
  "invitations",
  "audit_logs",
  "auth_organization_identities",
  "auth_user_identities",
  "organization_members",
  "users",
  "organizations",
  "allowlist",
] as const;

async function truncateAllTables(env: Env): Promise<void> {
  const db = getDb(env);

  try {
    await db
      .prepare(`TRUNCATE TABLE ${POSTGRES_TEST_TABLES.join(", ")} RESTART IDENTITY CASCADE`)
      .run();
  } catch (error) {
    throw new Error(
      "Postgres schema is not bootstrapped. Run `pnpm db:postgres:up` and `pnpm --filter @sdp/api db:postgres:bootstrap` first.",
      {
        cause: error,
      }
    );
  }
}

export async function seedTestDatabase(env: Env): Promise<void> {
  await truncateAllTables(env);
}

export async function clearTestDatabase(env: Env): Promise<void> {
  await truncateAllTables(env);
}
