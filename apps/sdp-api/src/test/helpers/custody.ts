/**
 * Custody test helpers
 */

import type { CustodyProvider } from "@sdp/custody";
import type { CustodyConfigStatus, CustodyWalletPurpose, CustodyWalletStatus } from "@sdp/types";
import { type DatabaseExecutor, getDb } from "@/db";
import type { SigningConfigRecord } from "@/services/adapters/signing";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";

/** A custody config record owned by a project, the only scope a config can have. */
export type TestCustodyConfigRecord = SigningConfigRecord & { projectId: string };

/**
 * Insert a custody config and point its project's scope default at it when active.
 * @param db - Executor the inserts run on.
 * @param config - Custody config row to insert.
 * @returns Resolves once the config and scope default are written.
 */
async function insertTestCustodyConfig(
  db: DatabaseExecutor,
  config: TestCustodyConfigRecord
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
        `SELECT id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?
         LIMIT 1`
      )
      .bind(config.organizationId, config.projectId)
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
  config: TestCustodyConfigRecord,
  wallet: CustodyWallet
): Promise<void> {
  await getDb(env).transaction(async (tx) => {
    await insertTestCustodyConfig(tx, config);
    await insertTestCustodyWallet(tx, wallet);
  });
}

export interface TestCustodyConfigRow {
  id: string;
  organizationId: string;
  projectId: string;
  provider: CustodyProvider;
  configEncrypted: string;
  defaultWalletId: string | null;
  status: CustodyConfigStatus;
}

export type TestCustodyWalletOwner =
  | { kind: "config"; custodyConfigId: string }
  | { kind: "connection"; custodyConnectionId: string };

export interface TestCustodyWalletRow {
  id: string;
  owner: TestCustodyWalletOwner;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: CustodyWalletPurpose | null;
  status: CustodyWalletStatus;
}

export interface TestCustodyScopeDefaultRow {
  id: string;
  organizationId: string;
  projectId: string;
  defaultCustodyConfigId: string | null;
  defaultCustodyConnectionId: string | null;
}

export interface TestCustodyRows {
  configs: readonly TestCustodyConfigRow[];
  wallets: readonly TestCustodyWalletRow[];
  scopeDefaults: readonly TestCustodyScopeDefaultRow[];
}

/**
 * Insert one `custody_configs` row exactly as given; no scope default is touched.
 * @param db - Executor the insert runs on.
 * @param config - The config row.
 * @returns Resolves once the row is written.
 */
export async function insertTestCustodyConfigRow(
  db: DatabaseExecutor,
  config: TestCustodyConfigRow
): Promise<void> {
  await db.execute(
    `INSERT INTO custody_configs
       (id, organization_id, project_id, provider, config_encrypted,
        encryption_version, default_wallet_id, status)
     VALUES (?, ?, ?, ?, ?, 'sdp-custody-encryption-v1', ?, ?)`,
    [
      config.id,
      config.organizationId,
      config.projectId,
      config.provider,
      config.configEncrypted,
      config.defaultWalletId,
      config.status,
    ]
  );
}

/**
 * Insert one `custody_wallets` row owned by a config or a connection.
 * @param db - Executor the insert runs on.
 * @param wallet - The wallet row and its owner.
 * @returns Resolves once the row is written.
 */
export async function insertTestCustodyWalletRow(
  db: DatabaseExecutor,
  wallet: TestCustodyWalletRow
): Promise<void> {
  await db.execute(
    `INSERT INTO custody_wallets
       (id, custody_config_id, custody_connection_id, wallet_id, public_key, label, purpose, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      wallet.id,
      wallet.owner.kind === "config" ? wallet.owner.custodyConfigId : null,
      wallet.owner.kind === "connection" ? wallet.owner.custodyConnectionId : null,
      wallet.walletId,
      wallet.publicKey,
      wallet.label,
      wallet.purpose,
      wallet.status,
    ]
  );
}

/**
 * Insert one `custody_scope_defaults` row.
 * @param db - Executor the insert runs on.
 * @param scopeDefault - The scope's selected config and connection.
 * @returns Resolves once the row is written.
 */
export async function insertTestCustodyScopeDefault(
  db: DatabaseExecutor,
  scopeDefault: TestCustodyScopeDefaultRow
): Promise<void> {
  await db.execute(
    `INSERT INTO custody_scope_defaults
       (id, organization_id, project_id, default_custody_config_id, default_custody_connection_id)
     VALUES (?, ?, ?, ?, ?)`,
    [
      scopeDefault.id,
      scopeDefault.organizationId,
      scopeDefault.projectId,
      scopeDefault.defaultCustodyConfigId,
      scopeDefault.defaultCustodyConnectionId,
    ]
  );
}

/**
 * Seed custody configs, their wallets and scope defaults in one transaction, so a
 * config naming its default wallet satisfies the deferred default-wallet FK at commit.
 * Connection-owned wallets need their connection seeded first.
 * @param env - Test environment bindings.
 * @param rows - The rows to insert.
 * @param rows.configs - Config rows, inserted first.
 * @param rows.wallets - Wallet rows, inserted after the configs.
 * @param rows.scopeDefaults - Scope default rows, inserted last.
 * @returns Resolves once the transaction commits.
 */
export async function seedTestCustodyRows(env: Env, rows: TestCustodyRows): Promise<void> {
  await getDb(env).transaction(async (tx) => {
    for (const config of rows.configs) await insertTestCustodyConfigRow(tx, config);
    for (const wallet of rows.wallets) await insertTestCustodyWalletRow(tx, wallet);
    for (const scopeDefault of rows.scopeDefaults) {
      await insertTestCustodyScopeDefault(tx, scopeDefault);
    }
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
    status: row.status as CustodyConfigStatus,
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
