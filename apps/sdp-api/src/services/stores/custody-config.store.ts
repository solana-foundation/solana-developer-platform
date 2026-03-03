/**
 * Custody Configuration Store
 *
 * D1 store for managing custody provider configurations and wallets.
 * Supports DB-backed default resolution with project → organization fallback.
 */

import type { SigningConfigRecord, SigningProviderType } from "@/services/adapters/signing";
import type {
  CreateSigningRequestParams,
  SigningConfigStore,
  SigningConfiguration,
  SigningRequestRecord,
  SigningRequestStore,
} from "@/services/domain/signing.service";
import { type EncryptionService, createEncryptionService } from "@/services/encryption.service";
import type { SignStatus } from "@/services/ports";

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

// D1 row types (snake_case)
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
}

interface SigningRequestRow {
  id: string;
  organization_id: string;
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
  default_custody_config_id: string;
  created_at: string;
  updated_at: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Custody Config Store Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class CustodyConfigStore implements SigningConfigStore {
  private encryptionService: EncryptionService | null = null;

  constructor(
    private db: D1Database,
    private encryptionKey?: string
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
    if (!scopeDefault) {
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
  async setDefaultConfig(orgId: string, projectId: string | undefined, configId: string): Promise<void> {
    const normalizedProjectId = projectId ?? null;

    const matchingConfig = await this.db
      .prepare(
        normalizedProjectId
          ? `SELECT id FROM custody_configs
             WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'
             LIMIT 1`
          : `SELECT id FROM custody_configs
             WHERE id = ? AND organization_id = ? AND project_id IS NULL AND status = 'active'
             LIMIT 1`
      )
      .bind(...(normalizedProjectId ? [configId, orgId, normalizedProjectId] : [configId, orgId]))
      .first<{ id: string }>();

    if (!matchingConfig) {
      throw new Error("Default config must be active and match the requested scope");
    }

    const scopeDefault = await this.getScopeDefaultRow(orgId, normalizedProjectId);
    if (scopeDefault) {
      await this.db
        .prepare(
          `UPDATE custody_scope_defaults
           SET default_custody_config_id = ?, updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(configId, scopeDefault.id)
        .run();
      return;
    }

    await this.db
      .prepare(
        `INSERT INTO custody_scope_defaults (id, organization_id, project_id, default_custody_config_id)
         VALUES (?, ?, ?, ?)`
      )
      .bind(`csd_${crypto.randomUUID()}`, orgId, normalizedProjectId, configId)
      .run();
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
    const normalizedProjectId = projectId ?? null;
    const provider = config.provider;

    // Check if config exists
    const existing = await this.db
      .prepare(
        normalizedProjectId
          ? "SELECT id FROM custody_configs WHERE organization_id = ? AND project_id = ? AND provider = ?"
          : "SELECT id FROM custody_configs WHERE organization_id = ? AND project_id IS NULL AND provider = ?"
      )
      .bind(...(normalizedProjectId ? [orgId, normalizedProjectId, provider] : [orgId, provider]))
      .first<{ id: string }>();

    const configJson = JSON.stringify(config);
    const encryption = this.getEncryptionService();
    const encryptedConfig = await encryption.encrypt(orgId, configJson);

    if (existing) {
      // Update existing config
      await this.db
        .prepare(
          `UPDATE custody_configs
           SET provider = ?, config_encrypted = ?, encryption_version = ?, default_wallet_id = ?, status = 'active', updated_at = datetime('now')
           WHERE id = ?`
        )
        .bind(
          config.provider,
          encryptedConfig.ciphertext,
          "sdp-custody-encryption-v1",
          config.defaultWalletId ?? null,
          existing.id
        )
        .run();

      return existing.id;
    }

    // Create new config
    const id = `cust_${crypto.randomUUID()}`;

    await this.db
      .prepare(
        `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, encryption_version, default_wallet_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active')`
      )
      .bind(
        id,
        orgId,
        normalizedProjectId,
        config.provider,
        encryptedConfig.ciphertext,
        "sdp-custody-encryption-v1",
        config.defaultWalletId ?? null
      )
      .run();

    return id;
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
   * Create a wallet record associated with a custody config.
   */
  async createWallet(configId: string, params: CreateWalletParams): Promise<CustodyWallet> {
    const id = `cwlt_${crypto.randomUUID()}`;

    await this.db
      .prepare(
        `INSERT INTO custody_wallets (id, custody_config_id, wallet_id, public_key, label, purpose, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`
      )
      .bind(
        id,
        configId,
        params.walletId,
        params.publicKey,
        params.label ?? null,
        params.purpose ?? null
      )
      .run();

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

  /**
   * Get a wallet by public key.
   */
  async getWalletByPublicKey(publicKey: string): Promise<CustodyWallet | null> {
    const row = await this.db
      .prepare(`SELECT * FROM custody_wallets WHERE public_key = ? AND status = 'active'`)
      .bind(publicKey)
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
      defaultWalletId: row.default_wallet_id,
      status: row.status as "active" | "inactive",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private getEncryptionService(): EncryptionService {
    if (!this.encryptionService) {
      this.encryptionService = createEncryptionService(this.encryptionKey);
    }
    return this.encryptionService;
  }

  private async getScopeDefaultRow(
    orgId: string,
    projectId: string | null
  ): Promise<CustodyScopeDefaultRow | null> {
    return this.db
      .prepare(
        projectId
          ? `SELECT id, organization_id, project_id, default_custody_config_id, created_at, updated_at
             FROM custody_scope_defaults
             WHERE organization_id = ? AND project_id = ?
             LIMIT 1`
          : `SELECT id, organization_id, project_id, default_custody_config_id, created_at, updated_at
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
}

// ═══════════════════════════════════════════════════════════════════════════
// Signing Request Store Implementation
// ═══════════════════════════════════════════════════════════════════════════

export class SigningRequestD1Store implements SigningRequestStore {
  constructor(private db: D1Database) {}

  /**
   * Create a new signing request record.
   */
  async create(params: CreateSigningRequestParams): Promise<string> {
    const id = `sig_${crypto.randomUUID()}`;

    await this.db
      .prepare(
        `INSERT INTO signing_requests
         (id, organization_id, custody_config_id, token_transaction_id, external_request_id, transaction_message, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        id,
        params.organizationId,
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
