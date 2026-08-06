import { CUSTODY_PROVIDERS, type CustodyProvider } from "@sdp/custody";
import { isFullSigningPort, SigningError, type SigningPort } from "@sdp/custody/signing";
import type { Address, TransactionSigner } from "@solana/kit";
import type { DatabaseClient, DatabaseExecutor } from "@/db";
import { conflict, forbidden, internalError, providerUnavailable } from "@/lib/errors";
import { isCustodyConnectionRuntimeEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import type { SigningConfigRecord } from "@/services/adapters";
import {
  type CredentialSecretStorageBackend,
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import { createPrivyAdapterFromCredential } from "@/services/domain/signing/provider-adapter-factory";
import type { Env } from "@/types/env";

const PRIVY_RUNTIME_ENV_FIELDS = {
  appId: "PRIVY_APP_ID",
  appSecret: "PRIVY_APP_SECRET",
} as const satisfies Record<string, keyof Env & string>;

type ConfigAdapterResolver = (
  organizationId: string,
  config: SigningConfigRecord
) => Promise<SigningPort>;

interface RuntimeWallet {
  walletId: string;
  publicKey: Address;
}

interface ConfigRuntimeTarget {
  kind: "config";
  provider: CustodyProvider;
  config: SigningConfigRecord;
  wallet?: RuntimeWallet;
  isRuntimeAvailable: true;
}

interface ConnectionRuntimeTarget {
  kind: "connection";
  provider: CustodyProvider;
  organizationId: string;
  projectId: string;
  connectionId: string;
  wallet: RuntimeWallet | null;
  isRuntimeAvailable: boolean;
}

export type CustodyRuntimeTarget = ConfigRuntimeTarget | ConnectionRuntimeTarget;

export type CustodyRuntimeTargetQuery =
  | {
      kind: "effective";
      organizationId: string;
      projectId?: string;
    }
  | {
      kind: "wallet";
      organizationId: string;
      projectId?: string;
      walletId: string;
    }
  | {
      kind: "provider";
      organizationId: string;
      projectId?: string;
      provider: CustodyProvider;
    };

interface ConfigRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  provider: string;
  config_encrypted: string;
  encryption_version: string;
  default_wallet_id: string | null;
  status: "active" | "inactive";
  created_at: string;
  updated_at: string;
}

interface ConfigWalletRow extends ConfigRow {
  wallet_id: string;
  wallet_public_key: string;
}

interface ConnectionTargetRow {
  connection_id: string;
  organization_id: string;
  project_id: string;
  provider: string;
  connection_status: string;
  last_check_status: string | null;
  credential_status: string;
  default_custody_wallet_id: string | null;
  default_wallet_id: string | null;
  default_wallet_public_key: string | null;
  default_wallet_status: string | null;
  wallet_id: string | null;
  wallet_public_key: string | null;
  wallet_status: string | null;
}

interface ConnectionCredentialRow {
  connection_id: string;
  provider: string;
  connection_status: string;
  last_check_status: string | null;
  default_wallet_id: string | null;
  default_wallet_status: string | null;
  provider_credential_id: string;
  credential_status: string;
  credential_version: number;
  source: "stored" | "runtime";
  storage_backend: CredentialSecretStorageBackend;
  secret_ref: string | null;
  secret_version_ref: string | null;
  encrypted_secret_payload: string | null;
}

interface ScopeDefaultRow {
  id: string;
  default_custody_config_id: string | null;
  default_custody_connection_id: string | null;
}

export class CustodyRuntimeTargets {
  constructor(
    private readonly db: DatabaseClient,
    private readonly env: Env,
    private readonly adapterCache: Map<string, SigningPort>
  ) {}

  async resolve(query: CustodyRuntimeTargetQuery): Promise<CustodyRuntimeTarget | null> {
    if (query.kind === "wallet") {
      return this.resolveWallet(query.organizationId, query.projectId, query.walletId);
    }
    if (query.kind === "provider") {
      return this.resolveProvider(query.organizationId, query.projectId, query.provider);
    }
    return this.resolveEffective(query.organizationId, query.projectId);
  }

  async getTransactionSigner(
    organizationId: string,
    projectId: string | undefined,
    walletId: string | undefined,
    getConfigAdapter: ConfigAdapterResolver
  ): Promise<TransactionSigner> {
    const target = await this.resolve(
      walletId
        ? { kind: "wallet", organizationId, projectId, walletId }
        : { kind: "effective", organizationId, projectId }
    );

    if (!target) {
      throw new SigningError(
        walletId ? "Custody wallet not found" : "Custody not initialized",
        walletId ? "WALLET_NOT_FOUND" : "NOT_FOUND"
      );
    }

    if (target.kind === "config") {
      const adapter = await getConfigAdapter(organizationId, target.config);
      return getTransactionSigner(adapter, target.wallet);
    }

    if (!isCustodyConnectionRuntimeEnabled(this.env, target.provider)) {
      this.logUnavailable(target, "runtime_disabled");
      throw forbidden("Custody Connection runtime is disabled");
    }

    if (!target.isRuntimeAvailable || !target.wallet) {
      this.logUnavailable(target, "connection_unusable");
      throw conflict("Custody Connection is unavailable");
    }

    const adapter = await this.getConnectionAdapter(target);
    return getTransactionSigner(adapter, target.wallet);
  }

  private async resolveEffective(
    organizationId: string,
    projectId: string | undefined
  ): Promise<CustodyRuntimeTarget | null> {
    if (
      projectId &&
      CUSTODY_PROVIDERS.some((provider) => isCustodyConnectionRuntimeEnabled(this.env, provider))
    ) {
      const connection = await this.findSelectedConnection(organizationId, projectId);
      if (connection && isCustodyConnectionRuntimeEnabled(this.env, connection.provider)) {
        return connection;
      }
    }

    const config = await findEffectiveConfig(this.db, organizationId, projectId);
    return config ? this.mapConfigTarget(config) : null;
  }

  private async resolveProvider(
    organizationId: string,
    projectId: string | undefined,
    provider: CustodyProvider
  ): Promise<CustodyRuntimeTarget | null> {
    if (!projectId || !isCustodyConnectionRuntimeEnabled(this.env, provider)) {
      const config = await findConfigByProvider(this.db, organizationId, projectId, provider);
      return config ? this.mapConfigTarget(config) : null;
    }

    const effective = await this.resolveEffective(organizationId, projectId);
    if (effective?.provider === provider) {
      return effective;
    }

    const connections = await this.db.queryMany<ConnectionTargetRow>(
      `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              pc.status AS credential_status,
              c.default_custody_wallet_id,
              w.wallet_id AS default_wallet_id,
              w.public_key AS default_wallet_public_key,
              w.status AS default_wallet_status,
              w.wallet_id,
              w.public_key AS wallet_public_key,
              w.status AS wallet_status
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       LEFT JOIN custody_wallets w
         ON w.id = c.default_custody_wallet_id
        AND w.custody_connection_id = c.id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.provider = ?
       ORDER BY c.updated_at DESC, c.id DESC`,
      [organizationId, projectId, provider]
    );
    const availableConnections = connections
      .map((connection) => this.mapConnectionTarget(connection))
      .filter((connection) => connection.isRuntimeAvailable);
    if (availableConnections.length > 1) {
      throw conflict("Connection selection is required");
    }
    if (availableConnections[0]) {
      return availableConnections[0];
    }
    if (connections.length > 0) {
      throw conflict("Custody Connection is unavailable");
    }

    const config = await findConfigByProvider(this.db, organizationId, projectId, provider);
    return config ? this.mapConfigTarget(config) : null;
  }

  private async resolveWallet(
    organizationId: string,
    projectId: string | undefined,
    walletId: string
  ): Promise<CustodyRuntimeTarget | null> {
    if (projectId) {
      const [connections, configs] = await Promise.all([
        this.db.queryMany<ConnectionTargetRow>(
          `${connectionTargetSelect()}
           WHERE c.organization_id = ?
             AND c.project_id = ?
             AND w.wallet_id = ?
           ORDER BY c.updated_at DESC, c.id DESC`,
          [organizationId, projectId, walletId]
        ),
        this.db.queryMany<ConfigWalletRow>(
          `${configWalletSelect()}
           WHERE c.organization_id = ?
             AND c.project_id = ?
             AND c.status = 'active'
             AND w.status = 'active'
             AND w.wallet_id = ?
           ORDER BY c.updated_at DESC, c.id DESC`,
          [organizationId, projectId, walletId]
        ),
      ]);

      if (connections.length + configs.length > 1) {
        throw conflict("Custody wallet ownership is ambiguous");
      }
      if (connections[0]) {
        return this.mapConnectionTarget(connections[0]);
      }
      if (configs[0]) {
        return this.mapConfigWalletTarget(configs[0]);
      }
    }

    const organizationConfig = await this.db.queryOne<ConfigWalletRow>(
      `${configWalletSelect()}
       WHERE c.organization_id = ?
         AND c.project_id IS NULL
         AND c.status = 'active'
         AND w.status = 'active'
         AND w.wallet_id = ?
       ORDER BY c.updated_at DESC, c.id DESC
       LIMIT 1`,
      [organizationId, walletId]
    );
    return organizationConfig ? this.mapConfigWalletTarget(organizationConfig) : null;
  }

  private async findSelectedConnection(
    organizationId: string,
    projectId: string
  ): Promise<ConnectionRuntimeTarget | null> {
    const row = await this.db.queryOne<ConnectionTargetRow>(
      `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              pc.status AS credential_status,
              c.default_custody_wallet_id,
              w.wallet_id AS default_wallet_id,
              w.public_key AS default_wallet_public_key,
              w.status AS default_wallet_status,
              w.wallet_id,
              w.public_key AS wallet_public_key,
              w.status AS wallet_status
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       LEFT JOIN custody_wallets w
         ON w.id = c.default_custody_wallet_id
        AND w.custody_connection_id = c.id
       JOIN custody_scope_defaults d
         ON d.default_custody_connection_id = c.id
        AND d.organization_id = c.organization_id
        AND d.project_id = c.project_id
       WHERE d.organization_id = ? AND d.project_id = ?
       LIMIT 1`,
      [organizationId, projectId]
    );
    return row ? this.mapConnectionTarget(row) : null;
  }

  private async getConnectionAdapter(target: ConnectionRuntimeTarget): Promise<SigningPort> {
    const row = await this.db.queryOne<ConnectionCredentialRow>(
      `SELECT c.id AS connection_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              default_wallet.wallet_id AS default_wallet_id,
              default_wallet.status AS default_wallet_status,
              pc.id AS provider_credential_id,
              pc.status AS credential_status,
              pc.credential_version, pc.source, pc.storage_backend,
              pc.secret_ref, pc.secret_version_ref, pc.encrypted_secret_payload
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       LEFT JOIN custody_wallets default_wallet
         ON default_wallet.id = c.default_custody_wallet_id
        AND default_wallet.custody_connection_id = c.id
       WHERE c.id = ?
         AND c.organization_id = ?
         AND c.project_id = ?
       LIMIT 1`,
      [target.connectionId, target.organizationId, target.projectId]
    );
    if (!row || !isUsableCredentialConnection(row)) {
      this.logUnavailable(target, "connection_changed");
      throw conflict("Custody Connection is unavailable");
    }

    if (row.provider !== "privy") {
      getLogger().error(
        {
          organizationId: target.organizationId,
          projectId: target.projectId,
          provider: row.provider,
          targetKind: "connection",
          reason: "unsupported_connection_provider",
        },
        "custody_runtime_target_unexpected"
      );
      throw internalError();
    }

    const cacheKey = [
      "connection",
      row.provider_credential_id,
      row.credential_version,
      row.secret_version_ref ?? "none",
    ].join(":");
    if (row.storage_backend !== "runtime_env") {
      const cached = this.adapterCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const secret = await this.readPrivyCredential(target, row);
    const adapter = createPrivyAdapterFromCredential(this.env, {
      ...secret,
      defaultWalletId: row.default_wallet_id,
    });
    if (row.storage_backend !== "runtime_env") {
      this.adapterCache.set(cacheKey, adapter);
    }
    return adapter;
  }

  private async readPrivyCredential(
    target: ConnectionRuntimeTarget,
    row: ConnectionCredentialRow
  ): Promise<{ appId: string; appSecret: string }> {
    const stored: StoredCredentialSecret = {
      storageBackend: row.storage_backend,
      secretRef: row.secret_ref ?? undefined,
      secretVersionRef: row.secret_version_ref ?? undefined,
      encryptedSecretPayload: row.encrypted_secret_payload ?? undefined,
      ...(row.storage_backend === "runtime_env"
        ? { runtimeEnvFields: PRIVY_RUNTIME_ENV_FIELDS }
        : {}),
    };

    try {
      const payload = await createCredentialSecretStore(this.env, row.storage_backend).read({
        orgId: target.organizationId,
        stored,
      });
      const appId = typeof payload.appId === "string" ? payload.appId.trim() : "";
      const appSecret = typeof payload.appSecret === "string" ? payload.appSecret : "";
      if (!appId || !appSecret) {
        throw new Error("incomplete credential payload");
      }
      return { appId, appSecret };
    } catch {
      this.logUnavailable(target, "credential_secret_unavailable");
      throw providerUnavailable("Custody credential is temporarily unavailable");
    }
  }

  private mapConfigTarget(row: ConfigRow): ConfigRuntimeTarget {
    const config = mapConfig(row, this.parseProvider(row.provider));
    return {
      kind: "config",
      provider: config.provider,
      config,
      isRuntimeAvailable: true,
    };
  }

  private mapConfigWalletTarget(row: ConfigWalletRow): ConfigRuntimeTarget {
    return {
      ...this.mapConfigTarget(row),
      wallet: {
        walletId: row.wallet_id,
        publicKey: row.wallet_public_key as Address,
      },
    };
  }

  private mapConnectionTarget(row: ConnectionTargetRow): ConnectionRuntimeTarget {
    const provider = this.parseProvider(row.provider);
    const wallet =
      row.wallet_id && row.wallet_public_key
        ? {
            walletId: row.wallet_id,
            publicKey: row.wallet_public_key as Address,
          }
        : null;
    return {
      kind: "connection",
      provider,
      organizationId: row.organization_id,
      projectId: row.project_id,
      connectionId: row.connection_id,
      wallet,
      isRuntimeAvailable:
        isCustodyConnectionRuntimeEnabled(this.env, provider) &&
        row.connection_status === "active" &&
        row.last_check_status === "success" &&
        row.credential_status === "active" &&
        row.wallet_status === "active" &&
        wallet !== null &&
        row.default_custody_wallet_id !== null &&
        row.default_wallet_id !== null &&
        row.default_wallet_public_key !== null &&
        row.default_wallet_status === "active",
    };
  }

  private parseProvider(provider: string): CustodyProvider {
    if (CUSTODY_PROVIDERS.includes(provider as CustodyProvider)) {
      return provider as CustodyProvider;
    }

    getLogger().error(
      { provider, targetKind: "connection", reason: "unknown_connection_provider" },
      "custody_runtime_target_unexpected"
    );
    throw internalError();
  }

  private logUnavailable(
    target: ConnectionRuntimeTarget,
    reason:
      | "runtime_disabled"
      | "connection_unusable"
      | "connection_changed"
      | "credential_secret_unavailable"
  ): void {
    getLogger().warn(
      {
        organizationId: target.organizationId,
        projectId: target.projectId,
        provider: target.provider,
        targetKind: "connection",
        reason,
      },
      "custody_runtime_target_unavailable"
    );
  }
}

export async function selectCustodyConfigTarget(
  db: DatabaseClient,
  params: {
    organizationId: string;
    projectId: string | undefined;
    configId: string;
  }
): Promise<void> {
  await db.transaction(async (tx) => {
    const owner = await tx.queryOne<{ id: string }>(
      params.projectId
        ? `SELECT id FROM projects
           WHERE id = ? AND organization_id = ? AND status = 'active'
           FOR UPDATE`
        : `SELECT id FROM organizations
           WHERE id = ? AND status = 'active'
           FOR UPDATE`,
      params.projectId ? [params.projectId, params.organizationId] : [params.organizationId]
    );
    if (!owner) {
      throw new SigningError("Custody target scope is unavailable", "NOT_FOUND");
    }

    const config = await tx.queryOne<{ id: string; provider: string }>(
      params.projectId
        ? `SELECT id, provider
           FROM custody_configs
           WHERE id = ?
             AND organization_id = ?
             AND project_id = ?
             AND status = 'active'
           FOR UPDATE`
        : `SELECT id, provider
           FROM custody_configs
           WHERE id = ?
             AND organization_id = ?
             AND project_id IS NULL
             AND status = 'active'
           FOR UPDATE`,
      params.projectId
        ? [params.configId, params.organizationId, params.projectId]
        : [params.configId, params.organizationId]
    );
    if (!config) {
      throw new SigningError(
        "Default config must be active and match the requested scope",
        "NOT_FOUND"
      );
    }

    const scopeDefault = params.projectId
      ? await findProjectScopeDefault(tx, params.organizationId, params.projectId, true)
      : await findOrganizationScopeDefault(tx, params.organizationId, true);
    if (!scopeDefault) {
      await tx.execute(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_config_id
         ) VALUES (?, ?, ?, ?)`,
        [
          `csd_${crypto.randomUUID()}`,
          params.organizationId,
          params.projectId ?? null,
          params.configId,
        ]
      );
      return;
    }

    const selectedConnection =
      params.projectId && scopeDefault.default_custody_connection_id
        ? await tx.queryOne<{ provider: string }>(
            `SELECT provider
             FROM custody_connections
             WHERE id = ? AND organization_id = ? AND project_id = ?`,
            [scopeDefault.default_custody_connection_id, params.organizationId, params.projectId]
          )
        : null;
    const clearConnection =
      Boolean(scopeDefault.default_custody_connection_id) &&
      selectedConnection?.provider !== config.provider;

    await tx.execute(
      `UPDATE custody_scope_defaults
       SET default_custody_config_id = ?,
           default_custody_connection_id = CASE WHEN ? THEN NULL
                                                ELSE default_custody_connection_id END,
           updated_at = sdp_iso_now()
       WHERE id = ?`,
      [params.configId, clearConnection, scopeDefault.id]
    );
  });
}

function getTransactionSigner(
  adapter: SigningPort,
  wallet: RuntimeWallet | undefined
): Promise<TransactionSigner> {
  if (!isFullSigningPort(adapter)) {
    throw new SigningError(
      `Provider does not support transaction signing: ${adapter.providerId}`,
      "INVALID_REQUEST"
    );
  }
  return adapter.getTransactionSigner(wallet?.walletId, wallet?.publicKey);
}

function connectionTargetSelect(): string {
  return `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
                 c.status AS connection_status, c.last_check_status,
                 pc.status AS credential_status,
                 c.default_custody_wallet_id,
                 default_wallet.wallet_id AS default_wallet_id,
                 default_wallet.public_key AS default_wallet_public_key,
                 default_wallet.status AS default_wallet_status,
                 w.wallet_id,
                 w.public_key AS wallet_public_key,
                 w.status AS wallet_status
          FROM custody_connections c
          JOIN provider_credentials pc ON pc.id = c.provider_credential_id
          JOIN custody_wallets w
            ON w.custody_connection_id = c.id
          LEFT JOIN custody_wallets default_wallet
            ON default_wallet.id = c.default_custody_wallet_id
           AND default_wallet.custody_connection_id = c.id`;
}

function configWalletSelect(): string {
  return `SELECT c.id, c.organization_id, c.project_id, c.provider,
                 c.config_encrypted, c.encryption_version,
                 c.default_wallet_id, c.status, c.created_at, c.updated_at,
                 w.wallet_id, w.public_key AS wallet_public_key
          FROM custody_configs c
          JOIN custody_wallets w ON w.custody_config_id = c.id`;
}

async function findEffectiveConfig(
  db: DatabaseExecutor,
  organizationId: string,
  projectId: string | undefined
): Promise<ConfigRow | null> {
  return db.queryOne<ConfigRow>(
    projectId
      ? `SELECT c.id, c.organization_id, c.project_id, c.provider,
                c.config_encrypted, c.encryption_version,
                c.default_wallet_id, c.status, c.created_at, c.updated_at
         FROM custody_scope_defaults d
         JOIN custody_configs c
           ON c.id = d.default_custody_config_id
          AND c.organization_id = d.organization_id
          AND c.project_id IS NOT DISTINCT FROM d.project_id
         WHERE d.organization_id = ?
           AND (d.project_id = ? OR d.project_id IS NULL)
           AND c.status = 'active'
         ORDER BY CASE WHEN d.project_id = ? THEN 0 ELSE 1 END
         LIMIT 1`
      : `SELECT c.id, c.organization_id, c.project_id, c.provider,
                c.config_encrypted, c.encryption_version,
                c.default_wallet_id, c.status, c.created_at, c.updated_at
         FROM custody_scope_defaults d
         JOIN custody_configs c
           ON c.id = d.default_custody_config_id
          AND c.organization_id = d.organization_id
          AND c.project_id IS NOT DISTINCT FROM d.project_id
         WHERE d.organization_id = ?
           AND d.project_id IS NULL
           AND c.status = 'active'
         LIMIT 1`,
    projectId ? [organizationId, projectId, projectId] : [organizationId]
  );
}

async function findConfigByProvider(
  db: DatabaseExecutor,
  organizationId: string,
  projectId: string | undefined,
  provider: CustodyProvider
): Promise<ConfigRow | null> {
  return db.queryOne<ConfigRow>(
    projectId
      ? `SELECT id, organization_id, project_id, provider,
                config_encrypted, encryption_version,
                default_wallet_id, status, created_at, updated_at
         FROM custody_configs
         WHERE organization_id = ?
           AND (project_id = ? OR project_id IS NULL)
           AND provider = ?
           AND status = 'active'
         ORDER BY CASE WHEN project_id = ? THEN 0 ELSE 1 END
         LIMIT 1`
      : `SELECT id, organization_id, project_id, provider,
                config_encrypted, encryption_version,
                default_wallet_id, status, created_at, updated_at
         FROM custody_configs
         WHERE organization_id = ?
           AND project_id IS NULL
           AND provider = ?
           AND status = 'active'
         LIMIT 1`,
    projectId ? [organizationId, projectId, provider, projectId] : [organizationId, provider]
  );
}

async function findProjectScopeDefault(
  db: DatabaseExecutor,
  organizationId: string,
  projectId: string,
  lock: boolean
): Promise<ScopeDefaultRow | null> {
  return db.queryOne<ScopeDefaultRow>(
    `SELECT id, default_custody_config_id, default_custody_connection_id
     FROM custody_scope_defaults
     WHERE organization_id = ? AND project_id = ?
     ${lock ? "FOR UPDATE" : ""}`,
    [organizationId, projectId]
  );
}

async function findOrganizationScopeDefault(
  db: DatabaseExecutor,
  organizationId: string,
  lock: boolean
): Promise<ScopeDefaultRow | null> {
  return db.queryOne<ScopeDefaultRow>(
    `SELECT id, default_custody_config_id, default_custody_connection_id
     FROM custody_scope_defaults
     WHERE organization_id = ? AND project_id IS NULL
     ${lock ? "FOR UPDATE" : ""}`,
    [organizationId]
  );
}

function mapConfig(row: ConfigRow, provider: CustodyProvider): SigningConfigRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    provider,
    config: row.config_encrypted,
    encryptionVersion: row.encryption_version,
    defaultWalletId: row.default_wallet_id,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUsableCredentialConnection(
  row: ConnectionCredentialRow
): row is ConnectionCredentialRow & {
  default_wallet_id: string;
} {
  return (
    row.connection_status === "active" &&
    row.last_check_status === "success" &&
    row.credential_status === "active" &&
    row.default_wallet_id !== null &&
    row.default_wallet_status === "active"
  );
}
