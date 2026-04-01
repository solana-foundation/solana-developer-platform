/**
 * Custody test helpers
 */

import { getDb } from "@/db";
import type { SigningConfigRecord } from "@/services/adapters/signing";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

/**
 * Seed a custody config into the test database.
 */
export async function seedTestCustodyConfig(env: Env, config: SigningConfigRecord): Promise<void> {
  await getDb(env)
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
    const existingDefault = await getDb(env)
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
      await getDb(env)
        .prepare(
          `UPDATE custody_scope_defaults
         SET default_custody_config_id = ?, updated_at = datetime('now')
         WHERE id = ?`
        )
        .bind(config.id, existingDefault.id)
        .run();
    } else {
      await getDb(env)
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
 * Seed a custody wallet into the test database.
 */
export async function seedTestCustodyWallet(env: Env, wallet: CustodyWallet): Promise<void> {
  await getDb(env)
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
 * Seed full custody setup (config + wallet) for an organization.
 */
export async function seedTestCustodySetup(
  env: Env,
  config: SigningConfigRecord,
  wallet: CustodyWallet
): Promise<void> {
  await seedTestCustodyConfig(env, config);
  await seedTestCustodyWallet(env, wallet);
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
      `SELECT id, organization_id, project_id, provider, config_encrypted as config, default_wallet_id, status, created_at, updated_at
     FROM custody_configs WHERE id = ?`
    )
    .bind(configId)
    .first<{
      id: string;
      organization_id: string;
      project_id: string | null;
      provider: string;
      config: string;
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
    ? `SELECT id, organization_id, project_id, provider, config_encrypted as config, default_wallet_id, status, created_at, updated_at
       FROM custody_configs WHERE organization_id = ? AND project_id = ? AND status = 'active'`
    : `SELECT id, organization_id, project_id, provider, config_encrypted as config, default_wallet_id, status, created_at, updated_at
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
