/**
 * Custody test helpers
 */

import type { CustodyProvider } from "@sdp/custody";
import type {
  CustodyConfigStatus,
  CustodyConnectionCheckStatus,
  CustodyWalletPurpose,
  CustodyWalletStatus,
} from "@sdp/types";
import { type DatabaseExecutor, getDb } from "@/db";
import type { SigningConfigRecord } from "@/services/adapters/signing";
import {
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import type { CustodyWallet } from "@/services/stores/custody-config.store";
import {
  activateTestCustodyConnection,
  insertTestCustodyConnection,
  insertTestStoredProviderCredential,
  setTestConnectionDefaultWallet,
} from "@/test/helpers/custody-connections";
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

export interface TestCustodyConfigRow {
  id: string;
  organizationId: string;
  projectId: string | null;
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
  projectId: string | null;
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

export interface TestPrivyConnectionSeed {
  organizationId: string;
  projectId: string;
  connectionId: string;
  credentialId: string;
  createdBy: string;
  stored: StoredCredentialSecret;
  providerAccountFingerprint: string;
  lastCheckStatus: Extract<CustodyConnectionCheckStatus, "success" | "retry_unknown">;
  wallets: readonly Omit<TestCustodyWalletRow, "owner">[];
  defaultCustodyWalletId: string;
}

/**
 * Write a Privy app credential through the `encrypted_db` secret store, so the
 * runtime reads it back exactly as a submitted BYOK credential. Needs
 * `CUSTODY_ENCRYPTION_KEY` on `env`.
 * @param env - Test environment bindings.
 * @param params - Credential owner and secret.
 * @param params.organizationId - Organization the secret is encrypted for.
 * @param params.credentialId - Provider credential id.
 * @param params.appId - Privy app id.
 * @param params.appSecret - Privy app secret.
 * @returns The stored secret location for the credential row.
 */
export async function writeTestPrivyCredentialSecret(
  env: Env,
  params: { organizationId: string; credentialId: string; appId: string; appSecret: string }
): Promise<StoredCredentialSecret> {
  return createCredentialSecretStore(env, "encrypted_db").write({
    orgId: params.organizationId,
    provider: "privy",
    providerCredentialId: params.credentialId,
    payload: { appId: params.appId, appSecret: params.appSecret },
  });
}

/**
 * Seed a project BYOK Privy connection over an active stored credential, with its
 * wallets and default wallet. `success` leaves it `active`; `retry_unknown` leaves
 * it `pending` with that last check.
 * @param db - Executor the writes run on; pass a transaction to seed atomically.
 * @param seed - The connection, credential and wallets.
 * @returns Resolves once the connection is in its final lifecycle state.
 */
export async function seedTestPrivyConnection(
  db: DatabaseExecutor,
  seed: TestPrivyConnectionSeed
): Promise<void> {
  const isActive = seed.lastCheckStatus === "success";
  await insertTestStoredProviderCredential(db, {
    id: seed.credentialId,
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    provider: "privy",
    label: "Privy",
    stored: seed.stored,
    displayMetadata: {},
    status: "active",
    credentialVersion: 1,
    rotatedFromProviderCredentialId: null,
    lastValidatedAt: null,
    deactivatedAt: null,
    createdBy: seed.createdBy,
  });
  await insertTestCustodyConnection(db, {
    id: seed.connectionId,
    organizationId: seed.organizationId,
    projectId: seed.projectId,
    provider: "privy",
    credential: { id: seed.credentialId, projectId: seed.projectId },
    status: "pending",
    setupMetadata: {},
    providerAccountFingerprint: seed.providerAccountFingerprint,
    lastCheckStatus: isActive ? null : seed.lastCheckStatus,
    lastCheckAt: isActive ? null : new Date().toISOString(),
    lastCheckFailureCode: null,
    activatedAt: null,
    deactivatedAt: null,
    createdBy: seed.createdBy,
    createdAt: new Date().toISOString(),
  });
  for (const wallet of seed.wallets) {
    await insertTestCustodyWalletRow(db, {
      ...wallet,
      owner: { kind: "connection", custodyConnectionId: seed.connectionId },
    });
  }
  if (isActive) {
    await activateTestCustodyConnection(db, {
      connectionId: seed.connectionId,
      custodyWalletId: seed.defaultCustodyWalletId,
      providerAccountFingerprint: seed.providerAccountFingerprint,
    });
  } else {
    await setTestConnectionDefaultWallet(db, {
      connectionId: seed.connectionId,
      custodyWalletId: seed.defaultCustodyWalletId,
    });
  }
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
