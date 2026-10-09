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
 * Insert a custody config.
 * @param db - Executor the insert runs on.
 * @param config - Custody config row to insert.
 * @returns Resolves once the config is written.
 */
async function insertTestCustodyConfig(
  db: DatabaseExecutor,
  config: TestCustodyConfigRecord
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO custody_configs
     (id, organization_id, project_id, provider, config_encrypted, encryption_version, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      config.id,
      config.organizationId,
      config.projectId,
      config.provider,
      config.config,
      "sdp-custody-encryption-v1",
      config.status,
      config.createdAt,
      config.updatedAt
    )
    .run();
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
 * Seed a custody config and its wallet in one transaction.
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

export interface TestCustodyRows {
  configs: readonly TestCustodyConfigRow[];
  wallets: readonly TestCustodyWalletRow[];
}

/**
 * Insert one `custody_configs` row exactly as given.
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
        encryption_version, status)
     VALUES (?, ?, ?, ?, ?, 'sdp-custody-encryption-v1', ?)`,
    [
      config.id,
      config.organizationId,
      config.projectId,
      config.provider,
      config.configEncrypted,
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
 * Seed custody configs and their wallets in one transaction. Connection-owned
 * wallets need their connection seeded first.
 * @param env - Test environment bindings.
 * @param rows - The rows to insert.
 * @param rows.configs - Config rows, inserted first.
 * @param rows.wallets - Wallet rows, inserted after the configs.
 * @returns Resolves once the transaction commits.
 */
export async function seedTestCustodyRows(env: Env, rows: TestCustodyRows): Promise<void> {
  await getDb(env).transaction(async (tx) => {
    for (const config of rows.configs) await insertTestCustodyConfigRow(tx, config);
    for (const wallet of rows.wallets) await insertTestCustodyWalletRow(tx, wallet);
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
      `SELECT id, organization_id, project_id, provider, config_encrypted as config, encryption_version, status, created_at, updated_at
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
