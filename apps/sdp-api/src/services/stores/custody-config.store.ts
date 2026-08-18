/**
 * Custody Configuration Store
 *
 * Store for managing custody provider configurations and wallets.
 * Supports DB-backed default resolution with project → organization fallback.
 */

import type { SignStatus } from "@sdp/custody/signing";
import type { PreparedStatement } from "@/db";
import type { SigningConfigRecord, SigningProviderType } from "@/services/adapters/signing";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import { selectCustodyConfigTarget } from "@/services/domain/signing/custody-runtime-target";
import type {
  CreateSigningRequestParams,
  SigningConfigStore,
  SigningConfiguration,
  SigningRequestRecord,
  SigningRequestStore,
} from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export interface CustodyWallet {
  id: string;
  custodyConfigId: string;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: WalletPurpose | null;
  status: "active" | "inactive";
  createdAt: string;
}

export interface CustodyWalletLookup extends CustodyWallet {
  provider: SigningProviderType;
  projectId: string | null;
}

export type WalletPurpose =
  | "root"
  | "mint_authority"
  | "freeze_authority"
  | "fee_payer"
  | "transfer";

export interface CreateWalletParams {
  walletId: string;
  publicKey: string;
  label?: string;
  purpose?: WalletPurpose;
}

export type DeactivateWalletResult = "deactivated" | "wallet_not_found" | "last_wallet";

// Database row types (snake_case)
interface CustodyConfigRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  provider: string;
  config_encrypted: string;
  encryption_version: string;
  default_wallet_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface CustodyWalletRow {
  id: string;
  custody_config_id: string;
  wallet_id: string;
  public_key: string;
  label: string | null;
  purpose: string | null;
  status: string;
  created_at: string;
  updated_at: string | null;
}

interface CustodyWalletLookupRow extends CustodyWalletRow {
  provider: string;
  project_id: string | null;
}

interface SigningRequestRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  custody_config_id: string;
  token_transaction_id: string | null;
  external_request_id: string | null;
  status: string;
  transaction_message: string;
  signatures: string | null;
  metadata: string | null;
  created_at: string;
  completed_at: string | null;
}

interface CustodyScopeDefaultRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  default_custody_config_id: string | null;
  default_custody_connection_id: string | null;
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Custody Config Store Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class CustodyConfigStore implements SigningConfigStore {
  private custodyCipher: CustodyCipher | null = null;

  constructor(
    private db: DatabaseClient,
    private env: Env
  ) {}

  /**
   * Find the active custody config for an organization/project.
   *
   * Resolution order:
   * 1. Project-specific config (if projectId provided)
   * 2. Organization-level config (project_id IS NULL)
   * 3. Returns null
   */
  async findActive(orgId: string, projectId?: string): Promise<SigningConfigRecord | null> {
    if (projectId) {
      const projectDefault = await this.getDefaultConfig(orgId, projectId);
      if (projectDefault) {
        return projectDefault;
      }
    }

    return this.getDefaultConfig(orgId, undefined);
  }

  /**
   * List active custody configs for a scope.
   */
  async listActive(orgId: string, projectId?: string): Promise<SigningConfigRecord[]> {
    const query = projectId
      ? `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
         FROM custody_configs
         WHERE organization_id = ? AND project_id = ? AND status = 'active'
         ORDER BY updated_at DESC, id DESC`
      : `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
         FROM custody_configs
         WHERE organization_id = ? AND project_id IS NULL AND status = 'active'
         ORDER BY updated_at DESC, id DESC`;

    const { results } = await this.db
      .prepare(query)
      .bind(...(projectId ? [orgId, projectId] : [orgId]))
      .all<CustodyConfigRow>();

    return results.map((row) => this.mapConfigRow(row));
  }

  /**
   * Find a custody config for a specific provider at the requested scope.
   * Returns active or inactive records (used for provider re-activation).
   */
  async findByProvider(
    orgId: string,
    projectId: string | undefined,
    provider: SigningProviderType
  ): Promise<SigningConfigRecord | null> {
    const row = await this.db
      .prepare(
        projectId
          ? `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
             FROM custody_configs
             WHERE organization_id = ? AND project_id = ? AND provider = ?
             LIMIT 1`
          : `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
             FROM custody_configs
             WHERE organization_id = ? AND project_id IS NULL AND provider = ?
             LIMIT 1`
      )
      .bind(...(projectId ? [orgId, projectId, provider] : [orgId, provider]))
      .first<CustodyConfigRow>();

    return row ? this.mapConfigRow(row) : null;
  }

  /**
   * Find an active config for a provider at a scope.
   */
  async findActiveByProvider(
    orgId: string,
    projectId: string | undefined,
    provider: SigningProviderType
  ): Promise<SigningConfigRecord | null> {
    const row = await this.db
      .prepare(
        projectId
          ? `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
             FROM custody_configs
             WHERE organization_id = ? AND project_id = ? AND provider = ? AND status = 'active'
             LIMIT 1`
          : `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
             FROM custody_configs
             WHERE organization_id = ? AND project_id IS NULL AND provider = ? AND status = 'active'
             LIMIT 1`
      )
      .bind(...(projectId ? [orgId, projectId, provider] : [orgId, provider]))
      .first<CustodyConfigRow>();

    return row ? this.mapConfigRow(row) : null;
  }

  /**
   * Get the default config for a scope.
   */
  async getDefaultConfig(orgId: string, projectId?: string): Promise<SigningConfigRecord | null> {
    const scopeDefault = await this.getScopeDefaultRow(orgId, projectId ?? null);
    if (!scopeDefault?.default_custody_config_id) {
      return null;
    }

    const config = await this.db
      .prepare(
        `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
         FROM custody_configs
         WHERE id = ? AND organization_id = ? AND status = 'active'
         LIMIT 1`
      )
      .bind(scopeDefault.default_custody_config_id, orgId)
      .first<CustodyConfigRow>();

    return config ? this.mapConfigRow(config) : null;
  }

  /**
   * Set the default config pointer for a scope.
   */
  async setDefaultConfig(
    orgId: string,
    projectId: string | undefined,
    configId: string
  ): Promise<void> {
    await selectCustodyConfigTarget(this.db, {
      organizationId: orgId,
      projectId,
      configId,
    });
  }

  /**
   * Get a custody config by ID.
   */
  async getById(configId: string): Promise<SigningConfigRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status, created_at, updated_at
         FROM custody_configs
         WHERE id = ?`
      )
      .bind(configId)
      .first<CustodyConfigRow>();

    return row ? this.mapConfigRow(row) : null;
  }

  /**
   * Create or update a custody config.
   * Uses UPSERT semantics - updates if exists, creates if not.
   *
   * @param orgId - Organization ID
   * @param projectId - Project ID (null for org-level config)
   * @param config - Configuration to store
   * @returns The config ID
   */
  async upsert(
    orgId: string,
    projectId: string | undefined,
    config: SigningConfiguration
  ): Promise<string> {
    const { encryptedConfig, encryptionVersion } = await this.encryptConfigJson(
      orgId,
      JSON.stringify(config)
    );

    const row = await this.db
      .prepare(this.buildConfigUpsertSql())
      .bind(
        `cust_${crypto.randomUUID()}`,
        orgId,
        projectId ?? null,
        config.provider,
        encryptedConfig,
        encryptionVersion,
        config.defaultWalletId ?? null
      )
      .first<{ id: string }>();

    if (!row) {
      throw new Error("Failed to upsert custody config");
    }

    return row.id;
  }

  /**
   * Persist a provider configuration and (optionally) its wallet record in a
   * single transaction: the config row never becomes readable with a partial
   * payload, and the default-wallet pointer lands together with the wallet it
   * references.
   */
  async saveProviderConfig(params: {
    orgId: string;
    projectId: string | undefined;
    provider: SigningProviderType;
    configJson: object;
    defaultWalletId: string | null;
    wallet?: CreateWalletParams;
  }): Promise<{ configId: string }> {
    const { encryptedConfig, encryptionVersion } = await this.encryptConfigJson(
      params.orgId,
      JSON.stringify(params.configJson)
    );

    return this.db.transaction(async (tx) => {
      const row = await tx
        .prepare(this.buildConfigUpsertSql())
        .bind(
          `cust_${crypto.randomUUID()}`,
          params.orgId,
          params.projectId ?? null,
          params.provider,
          encryptedConfig,
          encryptionVersion,
          params.defaultWalletId
        )
        .first<{ id: string }>();

      if (!row) {
        throw new Error("Failed to upsert custody config");
      }

      if (params.wallet) {
        await tx
          .prepare(
            `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, purpose, status, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 'active', STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`
          )
          .bind(
            `cwlt_${crypto.randomUUID()}`,
            row.id,
            params.wallet.walletId,
            params.wallet.publicKey,
            params.wallet.label ?? null,
            params.wallet.purpose ?? null
          )
          .run();
      }

      return { configId: row.id };
    });
  }

  /**
   * Atomic per-scope config upsert. Relies on the NULLS NOT DISTINCT unique
   * constraint on (organization_id, project_id, provider) so org-level scopes
   * (project_id IS NULL) race-resolve to a single row too.
   */
  private buildConfigUpsertSql(): string {
    return `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT (organization_id, project_id, provider)
       DO UPDATE SET
         config_encrypted = EXCLUDED.config_encrypted,
         encryption_version = EXCLUDED.encryption_version,
         default_wallet_id = EXCLUDED.default_wallet_id,
         status = 'active',
         updated_at = datetime('now')
       RETURNING id`;
  }

  private async encryptConfigJson(
    orgId: string,
    configJson: string
  ): Promise<{ encryptedConfig: string; encryptionVersion: string }> {
    const encryptedConfig = await this.getCustodyCipher().encrypt(orgId, configJson);
    return {
      encryptedConfig,
      encryptionVersion: encryptedConfig.startsWith("v2.")
        ? "sdp-custody-kms-v2"
        : "sdp-custody-encryption-v1",
    };
  }

  /**
   * Deactivate a custody config.
   */
  async deactivate(configId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE custody_configs SET status = 'inactive', updated_at = datetime('now') WHERE id = ?`
      )
      .bind(configId)
      .run();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Wallet Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Create a wallet record associated with a custody config. With
   * `setDefault`, the insert and the config's default-wallet promotion land
   * in one atomic batch.
   */
  async createWallet(
    configId: string,
    params: CreateWalletParams,
    options: { setDefault?: boolean } = {}
  ): Promise<CustodyWallet> {
    const id = `cwlt_${crypto.randomUUID()}`;

    const statements: PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO custody_wallets (
             id,
             custody_config_id,
             wallet_id,
             public_key,
             label,
             purpose,
             status,
             updated_at
           )
           VALUES (?, ?, ?, ?, ?, ?, 'active', STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))`
        )
        .bind(
          id,
          configId,
          params.walletId,
          params.publicKey,
          params.label ?? null,
          params.purpose ?? null
        ),
    ];

    if (options.setDefault) {
      statements.push(
        this.db
          .prepare(
            `UPDATE custody_configs
             SET default_wallet_id = ?, updated_at = datetime('now')
             WHERE id = ?`
          )
          .bind(params.walletId, configId)
      );
    }

    await this.db.batch(statements);

    const row = await this.db
      .prepare("SELECT * FROM custody_wallets WHERE id = ?")
      .bind(id)
      .first<CustodyWalletRow>();

    if (!row) {
      throw new Error("Failed to create wallet");
    }

    return this.mapWalletRow(row);
  }

  /**
   * Get all wallets for a custody config.
   */
  async getWallets(configId: string): Promise<CustodyWallet[]> {
    const { results } = await this.db
      .prepare(`SELECT * FROM custody_wallets WHERE custody_config_id = ? AND status = 'active'`)
      .bind(configId)
      .all<CustodyWalletRow>();

    return results.map(this.mapWalletRow);
  }

  async getWalletsForConfigs(configIds: string[]): Promise<Map<string, CustodyWallet[]>> {
    if (configIds.length === 0) {
      return new Map();
    }

    const placeholders = configIds.map(() => "?").join(", ");
    const { results } = await this.db
      .prepare(
        `SELECT * FROM custody_wallets
         WHERE custody_config_id IN (${placeholders}) AND status = 'active'
         ORDER BY created_at ASC`
      )
      .bind(...configIds)
      .all<CustodyWalletRow>();

    const walletsByConfigId = new Map(
      configIds.map((configId) => [configId, [] as CustodyWallet[]])
    );

    for (const row of results) {
      const wallets = walletsByConfigId.get(row.custody_config_id);
      if (wallets) {
        wallets.push(this.mapWalletRow(row));
      }
    }

    return walletsByConfigId;
  }

  /**
   * Find a single active wallet by identifier (wallet_id or custody_wallets.id)
   * within the resolved scope (project-first, then org fallback).
   */
  async findActiveWalletByIdentifier(
    orgId: string,
    projectId: string | undefined,
    walletIdentifier: string
  ): Promise<CustodyWalletLookup | null> {
    const rows = await this.queryActiveWalletsByIdentifier(orgId, projectId, walletIdentifier, 1);
    return rows.length === 1 ? this.mapWalletLookupRow(rows[0]) : null;
  }

  /**
   * Find an active wallet only when its identifier resolves to one custody row in scope.
   *
   * @param orgId - The organization that owns the wallet.
   * @param projectId - The project whose wallets and organization fallbacks are eligible.
   * @param walletIdentifier - A provider wallet ID or custody-wallet row ID.
   * @returns The unique active wallet, or null when zero or multiple rows match.
   */
  async findUniqueActiveWalletByIdentifier(
    orgId: string,
    projectId: string | undefined,
    walletIdentifier: string
  ): Promise<CustodyWalletLookup | null> {
    const rows = await this.queryActiveWalletsByIdentifier(orgId, projectId, walletIdentifier, 2);
    return rows.length === 1 ? this.mapWalletLookupRow(rows[0]) : null;
  }

  /**
   * Query active wallets matching an identifier within the resolved scope,
   * project-scoped configs first, then organization-level fallbacks. Without a
   * project, only organization-level configs match.
   *
   * @param orgId - The organization that owns the wallet.
   * @param projectId - The project whose wallets and organization fallbacks are eligible.
   * @param walletIdentifier - A provider wallet ID or custody-wallet row ID.
   * @param limit - The maximum number of rows to return.
   * @returns The matching wallet lookup rows in scope-priority order.
   */
  private async queryActiveWalletsByIdentifier(
    orgId: string,
    projectId: string | undefined,
    walletIdentifier: string,
    limit: number
  ): Promise<CustodyWalletLookupRow[]> {
    const projectScope = projectId === undefined ? null : projectId;
    const rows = await this.db
      .prepare(
        `SELECT
           w.id,
           w.custody_config_id,
           w.wallet_id,
           w.public_key,
           w.label,
           w.purpose,
           w.status,
           w.created_at,
           w.updated_at,
           c.provider,
           c.project_id
         FROM custody_wallets w
         JOIN custody_configs c ON c.id = w.custody_config_id
         WHERE c.organization_id = ?
           AND c.status = 'active'
           AND w.status = 'active'
           AND (w.wallet_id = ? OR w.id = ?)
           AND (c.project_id = ? OR c.project_id IS NULL)
         ORDER BY CASE WHEN c.project_id = ? THEN 0 ELSE 1 END, c.updated_at DESC, c.id DESC
         LIMIT ?`
      )
      .bind(orgId, walletIdentifier, walletIdentifier, projectScope, projectScope, limit)
      .all<CustodyWalletLookupRow>();
    return rows.results;
  }

  /**
   * Find a single active wallet by public key within the resolved scope
   * (project-first, then organization fallback).
   */
  async findActiveWalletByPublicKey(
    orgId: string,
    projectId: string | undefined,
    publicKey: string
  ): Promise<CustodyWalletLookup | null> {
    const row = projectId
      ? await this.db
          .prepare(
            `SELECT
               w.id,
               w.custody_config_id,
               w.wallet_id,
               w.public_key,
               w.label,
               w.purpose,
               w.status,
               w.created_at,
               w.updated_at,
               c.provider,
               c.project_id
             FROM custody_wallets w
             JOIN custody_configs c ON c.id = w.custody_config_id
             WHERE c.organization_id = ?
               AND c.status = 'active'
               AND w.status = 'active'
               AND w.public_key = ?
               AND (c.project_id = ? OR c.project_id IS NULL)
             ORDER BY CASE WHEN c.project_id = ? THEN 0 ELSE 1 END, c.updated_at DESC, c.id DESC
             LIMIT 1`
          )
          .bind(orgId, publicKey, projectId, projectId)
          .first<CustodyWalletLookupRow>()
      : await this.db
          .prepare(
            `SELECT
               w.id,
               w.custody_config_id,
               w.wallet_id,
               w.public_key,
               w.label,
               w.purpose,
               w.status,
               w.created_at,
               w.updated_at,
               c.provider,
               c.project_id
             FROM custody_wallets w
             JOIN custody_configs c ON c.id = w.custody_config_id
             WHERE c.organization_id = ?
               AND c.project_id IS NULL
               AND c.status = 'active'
               AND w.status = 'active'
               AND w.public_key = ?
             ORDER BY c.updated_at DESC, c.id DESC
             LIMIT 1`
          )
          .bind(orgId, publicKey)
          .first<CustodyWalletLookupRow>();

    return row ? this.mapWalletLookupRow(row) : null;
  }

  /**
   * Deactivate a wallet record associated with a custody config.
   */
  async deactivateWallet(configId: string, walletId: string): Promise<void> {
    const existing = await this.db
      .prepare(
        `SELECT id
         FROM custody_wallets
         WHERE custody_config_id = ? AND wallet_id = ? AND status = 'active'
         LIMIT 1`
      )
      .bind(configId, walletId)
      .first<{ id: string }>();

    if (!existing) {
      throw new Error("Wallet not found");
    }

    await this.db
      .prepare(
        `UPDATE custody_wallets
         SET status = 'inactive', updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = ?`
      )
      .bind(existing.id)
      .run();
  }

  /**
   * Deactivate a wallet only when at least one other active wallet exists.
   * Returns an enum result to support race-safe last-wallet guards.
   */
  async deactivateWalletIfNotLast(
    configId: string,
    walletId: string
  ): Promise<DeactivateWalletResult> {
    const result = await this.db
      .prepare(
        `UPDATE custody_wallets
         SET status = 'inactive', updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id = (
           SELECT id
           FROM custody_wallets
           WHERE custody_config_id = ? AND wallet_id = ? AND status = 'active'
           LIMIT 1
         )
         AND (
           SELECT COUNT(*)
           FROM custody_wallets
           WHERE custody_config_id = ? AND status = 'active'
         ) > 1`
      )
      .bind(configId, walletId, configId)
      .run();

    if (result > 0) {
      return "deactivated";
    }

    const activeWallet = await this.db
      .prepare(
        `SELECT id
         FROM custody_wallets
         WHERE custody_config_id = ? AND wallet_id = ? AND status = 'active'
         LIMIT 1`
      )
      .bind(configId, walletId)
      .first<{ id: string }>();

    if (!activeWallet) {
      return "wallet_not_found";
    }

    return "last_wallet";
  }

  /**
   * Reactivate a wallet previously marked inactive.
   * Used as a best-effort rollback when external delete fails.
   */
  async reactivateWallet(configId: string, walletId: string): Promise<void> {
    await this.db
      .prepare(
        `UPDATE custody_wallets
         SET status = 'active', updated_at = STRFTIME('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE custody_config_id = ? AND wallet_id = ? AND status = 'inactive'`
      )
      .bind(configId, walletId)
      .run();
  }

  /**
   * Get a wallet by purpose for a custody config.
   */
  async getWalletByPurpose(
    configId: string,
    purpose: WalletPurpose
  ): Promise<CustodyWallet | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM custody_wallets
         WHERE custody_config_id = ? AND purpose = ? AND status = 'active'`
      )
      .bind(configId, purpose)
      .first<CustodyWalletRow>();

    return row ? this.mapWalletRow(row) : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Row Mappers
  // ═══════════════════════════════════════════════════════════════════════════

  private mapConfigRow(row: CustodyConfigRow): SigningConfigRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      provider: row.provider as SigningProviderType,
      config: row.config_encrypted,
      encryptionVersion: row.encryption_version,
      defaultWalletId: row.default_wallet_id,
      status: row.status as "active" | "inactive",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getCustodyCipher(): CustodyCipher {
    if (!this.custodyCipher) {
      this.custodyCipher = createCustodyCipher(this.env);
    }
    return this.custodyCipher;
  }

  private async getScopeDefaultRow(
    orgId: string,
    projectId: string | null
  ): Promise<CustodyScopeDefaultRow | null> {
    return this.db
      .prepare(
        projectId
          ? `SELECT id, organization_id, project_id, default_custody_config_id, default_custody_connection_id, created_at, updated_at
             FROM custody_scope_defaults
             WHERE organization_id = ? AND project_id = ?
             LIMIT 1`
          : `SELECT id, organization_id, project_id, default_custody_config_id, default_custody_connection_id, created_at, updated_at
             FROM custody_scope_defaults
             WHERE organization_id = ? AND project_id IS NULL
             LIMIT 1`
      )
      .bind(...(projectId ? [orgId, projectId] : [orgId]))
      .first<CustodyScopeDefaultRow>();
  }

  private mapWalletRow(row: CustodyWalletRow): CustodyWallet {
    return {
      id: row.id,
      custodyConfigId: row.custody_config_id,
      walletId: row.wallet_id,
      publicKey: row.public_key,
      label: row.label,
      purpose: row.purpose as WalletPurpose | null,
      status: row.status as "active" | "inactive",
      createdAt: row.created_at,
    };
  }

  private mapWalletLookupRow(row: CustodyWalletLookupRow): CustodyWalletLookup {
    return {
      ...this.mapWalletRow(row),
      provider: row.provider as SigningProviderType,
      projectId: row.project_id,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Signing Request Store Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class SigningRequestStorePg implements SigningRequestStore {
  constructor(private db: DatabaseClient) {}

  /**
   * Create a new signing request record.
   */
  async create(params: CreateSigningRequestParams): Promise<string> {
    const id = `sig_${crypto.randomUUID()}`;

    await this.db
      .prepare(
        `INSERT INTO signing_requests
         (id, organization_id, project_id, custody_config_id, token_transaction_id, external_request_id, transaction_message, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        params.organizationId,
        params.projectId,
        params.custodyConfigId,
        params.tokenTransactionId ?? null,
        params.externalRequestId,
        params.transactionMessage,
        params.metadata ? JSON.stringify(params.metadata) : null
      )
      .run();

    return id;
  }

  /**
   * Find a signing request by ID or external request ID.
   */
  async findByIdOrExternal(requestId: string): Promise<SigningRequestRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM signing_requests
         WHERE id = ? OR external_request_id = ?`
      )
      .bind(requestId, requestId)
      .first<SigningRequestRow>();

    return row ? this.mapRequestRow(row) : null;
  }

  /**
   * Update the status of a signing request.
   */
  async updateStatus(id: string, status: SignStatus): Promise<void> {
    if (status.status === "completed" && status.signatures) {
      // Serialize signatures for storage
      const signaturesJson = JSON.stringify(
        Array.from(status.signatures.entries()).map(([publicKey, signature]) => ({
          publicKey,
          signature: encodeBase64(signature),
        }))
      );

      await this.db
        .prepare(
          `UPDATE signing_requests
           SET status = 'completed', signatures = ?, completed_at = datetime('now')
           WHERE id = ?`
        )
        .bind(signaturesJson, id)
        .run();
    } else if (status.status === "rejected") {
      await this.db
        .prepare(
          `UPDATE signing_requests
           SET status = 'rejected', completed_at = datetime('now')
           WHERE id = ?`
        )
        .bind(id)
        .run();
    } else if (status.status === "failed") {
      await this.db
        .prepare(
          `UPDATE signing_requests
           SET status = 'failed', completed_at = datetime('now')
           WHERE id = ?`
        )
        .bind(id)
        .run();
    }
  }

  /**
   * Get all pending signing requests for polling.
   */
  async findPending(orgId?: string): Promise<SigningRequestRecord[]> {
    const query = orgId
      ? `SELECT * FROM signing_requests WHERE status = 'pending' AND organization_id = ?`
      : `SELECT * FROM signing_requests WHERE status = 'pending'`;

    const { results } = await this.db
      .prepare(query)
      .bind(...(orgId ? [orgId] : []))
      .all<SigningRequestRow>();

    return results.map(this.mapRequestRow);
  }

  private mapRequestRow(row: SigningRequestRow): SigningRequestRecord {
    return {
      id: row.id,
      organizationId: row.organization_id,
      projectId: row.project_id,
      custodyConfigId: row.custody_config_id,
      tokenTransactionId: row.token_transaction_id,
      externalRequestId: row.external_request_id,
      status: row.status as "pending" | "completed" | "rejected" | "failed",
      transactionMessage: row.transaction_message,
      signatures: row.signatures,
      metadata: row.metadata,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Utilities
// ═══════════════════════════════════════════════════════════════════════════

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}
