/**
 * Custody test helpers
 */

import { type DatabaseExecutor, getDb } from "@/db";
import type { SigningConfigRecord } from "@/services/adapters/signing";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

/**
 * Insert a custody config and point its scope default at it when active.
 * @param db - Executor the inserts run on.
 * @param config - Custody config row to insert.
 * @returns Resolves once the config and scope default are written.
 */
async function insertTestCustodyConfig(
  db: DatabaseExecutor,
  config: SigningConfigRecord
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO custody_configs
     (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      config.id,
      config.organizationId,
      config.projectId,
      config.provider,
      config.config,
      "sdp-custody-encryption-v1",
      config.defaultWalletId,
      config.status,
      config.createdAt,
      config.updatedAt
    )
    .run();

  if (config.status === "active") {
    const existingDefault = await db
      .prepare(
        config.projectId
          ? `SELECT id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id = ?
           LIMIT 1`
          : `SELECT id
           FROM custody_scope_defaults
           WHERE organization_id = ? AND project_id IS NULL
           LIMIT 1`
      )
      .bind(
        ...(config.projectId ? [config.organizationId, config.projectId] : [config.organizationId])
      )
      .first<{ id: string }>();

    if (existingDefault) {
      await db
        .prepare(
          `UPDATE custody_scope_defaults
         SET default_custody_config_id = ?, updated_at = datetime('now')
         WHERE id = ?`
        )
        .bind(config.id, existingDefault.id)
        .run();
    } else {
      await db
        .prepare(
          `INSERT INTO custody_scope_defaults (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
        )
        .bind(`csd_${config.id}`, config.organizationId, config.projectId, config.id)
        .run();
    }
  }
}

/**
 * Insert a custody wallet.
 * @param db - Executor the insert runs on.
 * @param wallet - Custody wallet row to insert.
 * @returns Resolves once the wallet is written.
 */
async function insertTestCustodyWallet(db: DatabaseExecutor, wallet: CustodyWallet): Promise<void> {
  await db
    .prepare(
      `INSERT INTO custody_wallets
     (id, custody_config_id, wallet_id, public_key, label, purpose, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      wallet.id,
      wallet.custodyConfigId,
      wallet.walletId,
      wallet.publicKey,
      wallet.label,
      wallet.purpose,
      wallet.status,
      wallet.createdAt
    )
    .run();
}

/**
 * Seed a custody config and its wallet in one transaction, so a config whose
 * `defaultWalletId` names that wallet satisfies the deferred
 * `custody_configs_default_wallet_fkey` at commit.
 * @param env - Test environment bindings.
 * @param config - Custody config row to insert.
 * @param wallet - Custody wallet row owned by `config`.
 * @returns Resolves once the transaction commits.
 */
export async function seedTestCustodySetup(
  env: Env,
  config: SigningConfigRecord,
  wallet: CustodyWallet
): Promise<void> {
  await getDb(env).transaction(async (tx) => {
    await insertTestCustodyConfig(tx, config);
    await insertTestCustodyWallet(tx, wallet);
  });
}

/**
 * Get custody config from test database by ID.
 */
export async function getTestCustodyConfig(
  env: Env,
  configId: string
): Promise<SigningConfigRecord | null> {
  const row = await getDb(env)
    .prepare(
      `SELECT id, organization_id, project_id, provider, config_encrypted as config, encryption_version, default_wallet_id, status, created_at, updated_at
     FROM custody_configs WHERE id = ?`
    )
    .bind(configId)
    .first<{
      id: string;
      organization_id: string;
      project_id: string | null;
      provider: string;
      config: string;
      encryption_version: string;
      default_wallet_id: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    provider: row.provider as
      | "local"
      | "fireblocks"
      | "privy"
      | "coinbase_cdp"
      | "para"
      | "turnkey",
    config: row.config,
    encryptionVersion: row.encryption_version,
    defaultWalletId: row.default_wallet_id,
    status: row.status as "active" | "inactive",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Get custody config by organization ID from test database.
 */
export async function getTestCustodyConfigByOrg(
  env: Env,
  orgId: string,
  projectId?: string
): Promise<SigningConfigRecord | null> {
  const query = projectId
    ? `SELECT id, organization_id, project_id, provider, config_encrypted as config, encryption_version, default_wallet_id, status, created_at, updated_at
       FROM custody_configs WHERE organization_id = ? AND project_id = ? AND status = 'active'`
    : `SELECT id, organization_id, project_id, provider, config_encrypted as config, encryption_version, default_wallet_id, status, created_at, updated_at
       FROM custody_configs WHERE organization_id = ? AND project_id IS NULL AND status = 'active'`;

  const row = await getDb(env)
    .prepare(query)
    .bind(...(projectId ? [orgId, projectId] : [orgId]))
    .first<{
      id: string;
      organization_id: string;
      project_id: string | null;
      provider: string;
      config: string;
      encryption_version: string;
      default_wallet_id: string | null;
      status: string;
      created_at: string;
      updated_at: string;
    }>();

  if (!row) return null;

  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    provider: row.provider as
      | "local"
      | "fireblocks"
      | "privy"
      | "coinbase_cdp"
      | "para"
      | "turnkey",
    config: row.config,
    encryptionVersion: row.encryption_version,
    defaultWalletId: row.default_wallet_id,
    status: row.status as "active" | "inactive",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Count custody configs in test database.
 */
export async function countTestCustodyConfigs(env: Env): Promise<number> {
  const result = await getDb(env).prepare("SELECT COUNT(*) as count FROM custody_configs").first<{
    count: number;
  }>();
  return result?.count ?? 0;
}

/**
 * Count custody wallets in test database.
 */
export async function countTestCustodyWallets(env: Env): Promise<number> {
  const result = await getDb(env).prepare("SELECT COUNT(*) as count FROM custody_wallets").first<{
    count: number;
  }>();
  return result?.count ?? 0;
}
