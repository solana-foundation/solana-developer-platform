import { type CustodyConfigStatus, UNARCHIVED_CUSTODY_CONFIG_STATUSES } from "@sdp/types";
import type { PreparedStatement } from "@/db";
import { buildInClause } from "@/db/postgres-utils";
import type { SigningConfigRecord, SigningProviderType } from "@/services/adapters/signing";
import { type CustodyCipher, createCustodyCipher } from "@/services/custody-cipher/cipher-router";
import type { SigningConfigStore } from "@/services/domain/signing.service";
import type { Env } from "@/types/env";

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

interface CustodyWalletFields {
  id: string;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: WalletPurpose | null;
  status: "active" | "inactive";
  createdAt: string;
}

export type CustodyWallet = CustodyWalletFields &
  (
    | { custodyConfigId: string; custodyConnectionId?: never }
    | { custodyConfigId?: never; custodyConnectionId: string }
  );

export interface CustodyConfigWallet extends CustodyWalletFields {
  custodyConfigId: string;
}

export interface CustodyWalletLookup extends CustodyConfigWallet {
  provider: SigningProviderType;
  projectId: string | null;
}

/**
 * Aliased rather than restated. This was a second copy of the same union, and a
 * purpose added to one of them silently failed to typecheck against the other —
 * which is what a duplicated union is for.
 */
import type { CustodyWalletPurpose } from "@sdp/types";

export type WalletPurpose = CustodyWalletPurpose;

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
   * List active custody configs for a project.
   */
  async listActive(orgId: string, projectId: string): Promise<SigningConfigRecord[]> {
    const { results } = await this.db
      .prepare(
        `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, status, created_at, updated_at
         FROM custody_configs
         WHERE organization_id = ? AND project_id = ? AND status = 'active'
         ORDER BY updated_at DESC, id DESC`
      )
      .bind(orgId, projectId)
      .all<CustodyConfigRow>();

    return results.map((row) => this.mapConfigRow(row));
  }

  /**
   * Find the project's config for a provider, active or inactive, so provider
   * re-activation reuses it. Archived configs are retired and never returned.
   */
  async findByProvider(
    orgId: string,
    projectId: string,
    provider: SigningProviderType
  ): Promise<SigningConfigRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, status, created_at, updated_at
         FROM custody_configs
         WHERE organization_id = ? AND project_id = ? AND provider = ?
           AND status IN (${buildInClause(UNARCHIVED_CUSTODY_CONFIG_STATUSES.length)})
         LIMIT 1`
      )
      .bind(orgId, projectId, provider, ...UNARCHIVED_CUSTODY_CONFIG_STATUSES)
      .first<CustodyConfigRow>();

    return row ? this.mapConfigRow(row) : null;
  }

  /**
   * Find the project's active config for a provider.
   */
  async findActiveByProvider(
    orgId: string,
    projectId: string,
    provider: SigningProviderType
  ): Promise<SigningConfigRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, status, created_at, updated_at
         FROM custody_configs
         WHERE organization_id = ? AND project_id = ? AND provider = ? AND status = 'active'
         LIMIT 1`
      )
      .bind(orgId, projectId, provider)
      .first<CustodyConfigRow>();

    return row ? this.mapConfigRow(row) : null;
  }

  /**
   * Get a custody config by ID.
   */
  async getById(configId: string): Promise<SigningConfigRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT id, organization_id, project_id, provider, config_encrypted, encryption_version, status, created_at, updated_at
         FROM custody_configs
         WHERE id = ?`
      )
      .bind(configId)
      .first<CustodyConfigRow>();

    return row ? this.mapConfigRow(row) : null;
  }

  /**
   * Persist a provider configuration and (optionally) its wallet record in a
   * single transaction: the config row never becomes readable with a partial
   * payload, and the wallet lands together with the config that owns it.
   */
  async saveProviderConfig(params: {
    orgId: string;
    projectId: string;
    provider: SigningProviderType;
    configJson: object;
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
          params.projectId,
          params.provider,
          encryptedConfig,
          encryptionVersion
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
   * Atomic per-project config upsert. The arbiter is the unarchived
   * (organization_id, project_id, provider) key: Postgres infers the full
   * unique constraint today and the `status <> 'archived'` partial index once
   * it exists, so concurrent initializations race-resolve to one row and an
   * archived row never blocks a fresh config for the same provider. The
   * predicate is SQL text because index inference needs a literal to prove
   * against the index predicate.
   */
  private buildConfigUpsertSql(): string {
    return `INSERT INTO custody_configs (id, organization_id, project_id, provider, config_encrypted, encryption_version, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')
       ON CONFLICT (organization_id, project_id, provider) WHERE status <> 'archived'
       DO UPDATE SET
         config_encrypted = EXCLUDED.config_encrypted,
         encryption_version = EXCLUDED.encryption_version,
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
   * Create a wallet record associated with a custody config.
   */
  async createWallet(configId: string, params: CreateWalletParams): Promise<CustodyConfigWallet> {
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
   * Get all active wallets for a custody config, oldest first with ID as a tie-break.
   */
  async getWallets(configId: string): Promise<CustodyConfigWallet[]> {
    const { results } = await this.db
      .prepare(
        `SELECT * FROM custody_wallets
         WHERE custody_config_id = ? AND status = 'active'
         ORDER BY created_at ASC, id ASC`
      )
      .bind(configId)
      .all<CustodyWalletRow>();

    return results.map(this.mapWalletRow);
  }

  async getWalletsForConfigs(configIds: string[]): Promise<Map<string, CustodyConfigWallet[]>> {
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
      configIds.map((configId) => [configId, [] as CustodyConfigWallet[]])
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
   * under one of the project's active configs.
   */
  async findActiveWalletByIdentifier(
    orgId: string,
    projectId: string,
    walletIdentifier: string
  ): Promise<CustodyWalletLookup | null> {
    const rows = await this.queryActiveWalletsByIdentifier(orgId, projectId, walletIdentifier, 1);
    return rows.length === 1 ? this.mapWalletLookupRow(rows[0]) : null;
  }

  /**
   * Find an active wallet only when its identifier resolves to one custody row in the project.
   *
   * @param orgId - The organization that owns the wallet.
   * @param projectId - The project whose config wallets are eligible.
   * @param walletIdentifier - A provider wallet ID or custody-wallet row ID.
   * @returns The unique active wallet, or null when zero or multiple rows match.
   */
  async findUniqueActiveWalletByIdentifier(
    orgId: string,
    projectId: string,
    walletIdentifier: string
  ): Promise<CustodyWalletLookup | null> {
    const rows = await this.queryActiveWalletsByIdentifier(orgId, projectId, walletIdentifier, 2);
    return rows.length === 1 ? this.mapWalletLookupRow(rows[0]) : null;
  }

  /**
   * Query active wallets matching an identifier under the project's active
   * configs, most recently updated config first.
   *
   * @param orgId - The organization that owns the wallet.
   * @param projectId - The project whose config wallets are eligible.
   * @param walletIdentifier - A provider wallet ID or custody-wallet row ID.
   * @param limit - The maximum number of rows to return.
   * @returns The matching wallet lookup rows.
   */
  private async queryActiveWalletsByIdentifier(
    orgId: string,
    projectId: string,
    walletIdentifier: string,
    limit: number
  ): Promise<CustodyWalletLookupRow[]> {
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
           AND c.project_id = ?
           AND c.status = 'active'
           AND w.status = 'active'
           AND (w.wallet_id = ? OR w.id = ?)
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT ?`
      )
      .bind(orgId, projectId, walletIdentifier, walletIdentifier, limit)
      .all<CustodyWalletLookupRow>();
    return rows.results;
  }

  /**
   * Find a single active wallet by public key under one of the project's
   * active configs.
   */
  async findActiveWalletByPublicKey(
    orgId: string,
    projectId: string,
    publicKey: string
  ): Promise<CustodyWalletLookup | null> {
    const row = await this.db
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
           AND c.project_id = ?
           AND c.status = 'active'
           AND w.status = 'active'
           AND w.public_key = ?
         ORDER BY c.updated_at DESC, c.id DESC
         LIMIT 1`
      )
      .bind(orgId, projectId, publicKey)
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

    await this.assertNotLoadBearingDvpAuthority(existing.id);

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
   * Refuses to deactivate a settlement authority that open trades depend on.
   *
   * The authority is a PDA seed on every trade created under it, so it cannot
   * be swapped after the fact: deactivating one with open trades makes each of
   * them permanently unsettleable and unrefundable BY ANYONE, including the
   * counterparty who has already paid into an escrow. Nothing recovers that.
   *
   * Only trades that are still open block it. Once they are all closed the
   * wallet is ordinary again and this stops caring.
   */
  private async assertNotLoadBearingDvpAuthority(custodyWalletId: string): Promise<void> {
    const blocking = await this.db
      .prepare(
        `SELECT COUNT(*) AS open_trades
           FROM dvp_settlement_wallets s
           JOIN dvp_trades t
             ON t.project_id = s.project_id
            AND t.status IN ('creating', 'created', 'partially_funded', 'funded', 'expired')
          WHERE s.custody_wallet_id = ?`
      )
      .bind(custodyWalletId)
      .first<{ open_trades: number | string }>();

    const openTrades = Number(blocking?.open_trades ?? 0);
    if (openTrades > 0) {
      throw new Error(
        `This wallet is the DvP settlement authority for ${openTrades} open trade(s). It is part of each trade's on-chain address, so deactivating it would leave them permanently unsettleable — settle or cancel them first.`
      );
    }
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
  ): Promise<CustodyConfigWallet | null> {
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
      status: row.status as CustodyConfigStatus,
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

  private mapWalletRow(row: CustodyWalletRow): CustodyConfigWallet {
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
