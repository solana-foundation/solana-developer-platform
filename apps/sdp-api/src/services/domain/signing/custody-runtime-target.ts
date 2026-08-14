import { CUSTODY_PROVIDERS, type CustodyProvider, normalizePrivyWalletId } from "@sdp/custody";
import { isFullSigningPort, SigningError, type SigningPort } from "@sdp/custody/signing";
import type { CustodyWalletPurpose } from "@sdp/types";
import type { Address, TransactionSigner } from "@solana/kit";
import type { DatabaseClient, DatabaseExecutor } from "@/db";
import {
  AppError,
  badRequest,
  conflict,
  forbidden,
  internalError,
  notFound,
  providerUnavailable,
} from "@/lib/errors";
import { isCustodyConnectionRuntimeEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import type { SigningConfigRecord } from "@/services/adapters";
import {
  type CredentialSecretStorageBackend,
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import {
  getPrivyProviderAccountFingerprint,
  PRIVY_RUNTIME_ENV_FIELDS,
} from "@/services/custody/privy-credential";
import { provisionPrivyWallet } from "@/services/custody/provisioning";
import { assertCustodyProviderCanCreateWallet } from "@/services/custody-provider-lifecycle.service";
import { createPrivyAdapterFromCredential } from "@/services/domain/signing/provider-adapter-factory";
import { getProviderAvailability } from "@/services/provider-availability.service";
import type { Env } from "@/types/env";

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

export type CustodyRuntimeWalletProjection = {
  id: string;
  provider: CustodyProvider;
  isDefaultProvider: boolean;
  isRuntimeExecutionAllowed: boolean;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: string | null;
  status: "active";
  createdAt: string;
} & (
  | { custodyConfigId: string; custodyConnectionId?: never }
  | { custodyConfigId?: never; custodyConnectionId: string }
);

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
    }
  | {
      kind: "connection";
      organizationId: string;
      projectId: string;
      connectionId: string;
    };

export interface CreatedCustodyConnectionWallet {
  id: string;
  custodyConnectionId: string;
  isRuntimeExecutionAllowed: true;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: CustodyWalletPurpose | null;
  status: "active";
  createdAt: string;
}

export type CustodyOwnedWallet = {
  id: string;
  provider: CustodyProvider;
  walletId: string;
} & (
  | { custodyConfigId: string; custodyConnectionId?: never }
  | { custodyConfigId?: never; custodyConnectionId: string }
);

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
  provider_account_fingerprint: string | null;
  default_custody_wallet_id: string | null;
  default_wallet_id: string | null;
  default_wallet_public_key: string | null;
  default_wallet_status: string | null;
  wallet_id: string | null;
  wallet_public_key: string | null;
  wallet_status: string | null;
}

interface OperationalConfigWalletRow {
  wallet_record_id: string;
  custody_config_id: string;
  provider: string;
  wallet_id: string;
  wallet_public_key: string;
  wallet_label: string | null;
  wallet_purpose: string | null;
  wallet_created_at: string;
}

interface OperationalConnectionWalletRow extends ConnectionTargetRow {
  wallet_record_id: string;
  wallet_id: string;
  wallet_public_key: string;
  wallet_status: "active";
  wallet_label: string | null;
  wallet_purpose: string | null;
  wallet_created_at: string;
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
  provider_account_fingerprint: string | null;
  request_delay_ms: number | null;
  credential_version: number;
  source: "stored" | "runtime";
  storage_backend: CredentialSecretStorageBackend;
  secret_ref: string | null;
  secret_version_ref: string | null;
  encrypted_secret_payload: string | null;
}

interface LockedConnectionWalletCreationRow {
  provider_credential_id: string;
  status: string;
  last_check_status: string | null;
  provider_account_fingerprint: string | null;
  default_custody_wallet_id: string | null;
}

interface LockedCredentialWalletCreationRow {
  status: string;
  credential_version: number;
}

interface CreatedConnectionWalletRow {
  id: string;
  wallet_id: string;
  public_key: string;
  label: string | null;
  purpose: CustodyWalletPurpose | null;
  created_at: string;
}

interface ScopeDefaultRow {
  id: string;
  default_custody_config_id: string | null;
  default_custody_connection_id: string | null;
}

interface SelectableConnectionRow {
  id: string;
  provider: string;
  status: string;
  last_check_status: string | null;
  credential_status: string;
  provider_account_fingerprint: string | null;
  default_custody_wallet_id: string | null;
}

export interface CustodyConnectionSelectionResult {
  connectionId: string;
  provider: CustodyProvider;
  walletId: string;
  publicKey: string;
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
    if (query.kind === "connection") {
      return this.resolveConnection(query.organizationId, query.projectId, query.connectionId);
    }
    return this.resolveEffective(query.organizationId, query.projectId);
  }

  async listWallets(params: {
    organizationId: string;
    projectId?: string;
    provider?: CustodyProvider;
    includeAllProviders: boolean;
  }): Promise<CustodyRuntimeWalletProjection[]> {
    const effective = await this.resolveEffective(params.organizationId, params.projectId);
    const [configRows, connectionRows] = await Promise.all([
      this.findOperationalConfigWallets(params.organizationId, params.projectId),
      params.projectId
        ? this.findOperationalConnectionWallets(params.organizationId, params.projectId)
        : Promise.resolve([]),
    ]);
    const wallets = [
      ...configRows.map((row) => this.mapOperationalConfigWallet(row, effective)),
      ...connectionRows.map((row) => this.mapOperationalConnectionWallet(row, effective)),
    ].filter((wallet) => !params.provider || wallet.provider === params.provider);

    if (params.includeAllProviders) {
      return sortRuntimeWallets(wallets);
    }

    const target = params.provider
      ? await this.resolveProvider(params.organizationId, params.projectId, params.provider)
      : effective;
    if (!target) {
      return [];
    }

    return sortRuntimeWallets(wallets.filter((wallet) => walletBelongsToTarget(wallet, target)));
  }

  async findOperationalWallet(params: {
    organizationId: string;
    projectId?: string;
    walletId: string;
    allowRecordIdAlias?: boolean;
  }): Promise<CustodyRuntimeWalletProjection | null> {
    const wallets = await this.listWallets({
      organizationId: params.organizationId,
      projectId: params.projectId,
      includeAllProviders: true,
    });
    const matches = wallets.filter(
      (wallet) =>
        wallet.walletId === params.walletId ||
        (params.allowRecordIdAlias === true && wallet.id === params.walletId)
    );
    if (matches.length > 1) {
      throw conflict("Custody wallet ownership is ambiguous");
    }
    return matches[0] ?? null;
  }

  async findOwnedWalletForMutation(params: {
    organizationId: string;
    projectId?: string;
    walletId: string;
  }): Promise<CustodyOwnedWallet | null> {
    const [configs, connections] = await Promise.all([
      this.db.queryMany<{
        id: string;
        custody_config_id: string;
        provider: string;
        wallet_id: string;
      }>(
        `SELECT w.id, w.custody_config_id, c.provider, w.wallet_id
         FROM custody_wallets w
         JOIN custody_configs c ON c.id = w.custody_config_id
         WHERE c.organization_id = ?
           AND ${params.projectId ? "(c.project_id = ? OR c.project_id IS NULL)" : "c.project_id IS NULL"}
           AND w.wallet_id = ?`,
        params.projectId
          ? [params.organizationId, params.projectId, params.walletId]
          : [params.organizationId, params.walletId]
      ),
      params.projectId
        ? this.db.queryMany<{
            id: string;
            custody_connection_id: string;
            provider: string;
            wallet_id: string;
          }>(
            `SELECT w.id, w.custody_connection_id, c.provider, w.wallet_id
             FROM custody_wallets w
             JOIN custody_connections c ON c.id = w.custody_connection_id
             WHERE c.organization_id = ?
               AND c.project_id = ?
               AND w.wallet_id = ?`,
            [params.organizationId, params.projectId, params.walletId]
          )
        : Promise.resolve([]),
    ]);
    const matches: CustodyOwnedWallet[] = [
      ...configs.map((wallet) => ({
        id: wallet.id,
        custodyConfigId: wallet.custody_config_id,
        provider: this.parseProvider(wallet.provider),
        walletId: wallet.wallet_id,
      })),
      ...connections.map((wallet) => ({
        id: wallet.id,
        custodyConnectionId: wallet.custody_connection_id,
        provider: this.parseProvider(wallet.provider),
        walletId: wallet.wallet_id,
      })),
    ];
    if (matches.length > 1) {
      throw conflict("Custody wallet ownership is ambiguous");
    }
    return matches[0] ?? null;
  }

  async createConnectionWallet(params: {
    organizationId: string;
    projectId: string;
    connectionId: string;
    provider?: CustodyProvider;
    label?: string;
    purpose?: CustodyWalletPurpose;
    setDefault?: boolean;
  }): Promise<CreatedCustodyConnectionWallet> {
    const target = await this.resolveConnection(
      params.organizationId,
      params.projectId,
      params.connectionId
    );
    if (!target) {
      throw notFound("Custody Connection");
    }
    if (params.provider && params.provider !== target.provider) {
      throw badRequest("Provider does not match Custody Connection");
    }
    assertCustodyProviderCanCreateWallet(target.provider);
    if (!isCustodyConnectionRuntimeEnabled(this.env, target.provider)) {
      throw forbidden("Custody Connection runtime is disabled");
    }
    if (!target.isRuntimeAvailable) {
      throw conflict("Custody Connection is unavailable");
    }

    const credential = await this.loadConnectionCredential(target);
    if (!credential || !isUsableCredentialConnection(credential)) {
      throw conflict("Custody Connection is unavailable");
    }
    const availability = await getProviderAvailability(this.env, this.db, params.organizationId);
    if (availability.providers.custody[target.provider]?.entitled !== true) {
      throw forbidden(`${target.provider} is unavailable for this organization`);
    }
    if (target.provider !== "privy") {
      throw internalError("Custody Connection provider is unsupported");
    }

    const authentication = await this.readPrivyCredential(target, credential);
    let provisioned: { walletId: string; address: string };
    try {
      provisioned = await provisionPrivyWallet(
        this.env,
        { credentialRequest: true },
        authentication
      );
    } catch (error) {
      if (!(error instanceof SigningError) || error.code === "NETWORK_ERROR") {
        this.logWalletOrphanRisk(target, "provider_result_unknown");
      }
      throw providerUnavailable("Custody provider is temporarily unavailable");
    }

    const providerWalletId = normalizePrivyWalletId(provisioned.walletId);
    try {
      return await this.persistConnectionWallet(target, credential, {
        walletId: providerWalletId,
        publicKey: provisioned.address,
        label: params.label,
        purpose: params.purpose,
        setDefault: params.setDefault,
      });
    } catch (error) {
      this.logWalletOrphanRisk(target, "persistence_failed", providerWalletId);
      if (error instanceof AppError && error.code === "CONFLICT") {
        throw error;
      }
      throw internalError("Failed to complete wallet creation");
    }
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

  private async resolveConnection(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<ConnectionRuntimeTarget | null> {
    const row = await this.db.queryOne<ConnectionTargetRow>(
      `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              pc.status AS credential_status, c.provider_account_fingerprint,
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
       WHERE c.id = ?
         AND c.organization_id = ?
         AND c.project_id = ?
       LIMIT 1`,
      [connectionId, organizationId, projectId]
    );
    return row ? this.mapConnectionTarget(row) : null;
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

    const config = await findConfigByProvider(this.db, organizationId, projectId, provider);
    if (config?.project_id === (projectId ?? null)) {
      return this.mapConfigTarget(config);
    }

    const connections = await this.db.queryMany<ConnectionTargetRow>(
      `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              pc.status AS credential_status, c.provider_account_fingerprint,
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
              pc.status AS credential_status, c.provider_account_fingerprint,
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
    const row = await this.loadConnectionCredential(target);
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
      row.connection_id,
      row.request_delay_ms ?? "env",
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
      requestDelayMs: row.request_delay_ms ?? undefined,
    });
    if (row.storage_backend !== "runtime_env") {
      this.adapterCache.set(cacheKey, adapter);
    }
    return adapter;
  }

  private async loadConnectionCredential(
    target: ConnectionRuntimeTarget
  ): Promise<ConnectionCredentialRow | null> {
    return this.db.queryOne<ConnectionCredentialRow>(
      `SELECT c.id AS connection_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              c.provider_account_fingerprint, c.request_delay_ms,
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
  }

  private async persistConnectionWallet(
    target: ConnectionRuntimeTarget,
    credential: ConnectionCredentialRow,
    wallet: {
      walletId: string;
      publicKey: string;
      label?: string;
      purpose?: CustodyWalletPurpose;
      setDefault?: boolean;
    }
  ): Promise<CreatedCustodyConnectionWallet> {
    return this.db.transaction(async (tx) => {
      const project = await tx.queryOne<{ id: string }>(
        `SELECT id
         FROM projects
         WHERE id = ? AND organization_id = ? AND status = 'active'
         FOR UPDATE`,
        [target.projectId, target.organizationId]
      );
      if (!project) {
        throw conflict("Custody Connection changed during wallet creation");
      }

      const connection = await tx.queryOne<LockedConnectionWalletCreationRow>(
        `SELECT provider_credential_id, status, last_check_status,
                provider_account_fingerprint, default_custody_wallet_id
         FROM custody_connections
         WHERE id = ? AND organization_id = ? AND project_id = ?
         FOR UPDATE`,
        [target.connectionId, target.organizationId, target.projectId]
      );
      if (!connection) {
        throw conflict("Custody Connection changed during wallet creation");
      }

      const currentCredential = await tx.queryOne<LockedCredentialWalletCreationRow>(
        `SELECT status, credential_version
         FROM provider_credentials
         WHERE id = ?
           AND organization_id = ?
           AND project_id = ?
         FOR UPDATE`,
        [credential.provider_credential_id, target.organizationId, target.projectId]
      );
      if (
        connection.status !== "active" ||
        connection.last_check_status !== "success" ||
        connection.provider_account_fingerprint !== credential.provider_account_fingerprint ||
        connection.default_custody_wallet_id === null ||
        connection.provider_credential_id !== credential.provider_credential_id ||
        currentCredential?.status !== "active" ||
        currentCredential.credential_version !== credential.credential_version
      ) {
        throw conflict("Custody Connection changed during wallet creation");
      }

      const id = `cwlt_${crypto.randomUUID()}`;
      const created = await tx.queryOne<CreatedConnectionWalletRow>(
        `INSERT INTO custody_wallets (
           id, custody_config_id, custody_connection_id, wallet_id,
           public_key, label, purpose, status, updated_at
         ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'active', sdp_iso_now())
         RETURNING id, wallet_id, public_key, label, purpose, created_at`,
        [
          id,
          target.connectionId,
          wallet.walletId,
          wallet.publicKey,
          wallet.label ?? null,
          wallet.purpose ?? null,
        ]
      );
      if (!created) {
        throw new Error("Wallet persistence returned no row");
      }

      if (wallet.setDefault) {
        const updated = await tx.execute(
          `UPDATE custody_connections
           SET default_custody_wallet_id = ?, updated_at = sdp_iso_now()
           WHERE id = ? AND status = 'active'`,
          [created.id, target.connectionId]
        );
        if (updated !== 1) {
          throw conflict("Custody Connection changed during wallet creation");
        }
      }

      return {
        id: created.id,
        custodyConnectionId: target.connectionId,
        isRuntimeExecutionAllowed: true,
        walletId: created.wallet_id,
        publicKey: created.public_key,
        label: created.label,
        purpose: created.purpose,
        status: "active",
        createdAt: created.created_at,
      };
    });
  }

  private logWalletOrphanRisk(
    target: ConnectionRuntimeTarget,
    reason: "provider_result_unknown" | "persistence_failed",
    walletId?: string
  ): void {
    getLogger().error(
      {
        organizationId: target.organizationId,
        projectId: target.projectId,
        connectionId: target.connectionId,
        provider: target.provider,
        reason,
        ...(walletId ? { walletId } : {}),
      },
      "custody_wallet_orphan_risk"
    );
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

    let credential: { appId: string; appSecret: string };
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
      credential = { appId, appSecret };
    } catch {
      this.logUnavailable(target, "credential_secret_unavailable");
      throw providerUnavailable("Custody credential is temporarily unavailable");
    }

    if (
      row.source === "runtime" &&
      (await getPrivyProviderAccountFingerprint(credential.appId)) !==
        row.provider_account_fingerprint
    ) {
      this.logUnavailable(target, "provider_account_mismatch");
      throw conflict("Custody runtime credential does not match the connected Provider account");
    }
    return credential;
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
      isRuntimeAvailable: this.isConnectionRuntimeAvailable(row) && wallet !== null,
    };
  }

  private async findOperationalConfigWallets(
    organizationId: string,
    projectId: string | undefined
  ): Promise<OperationalConfigWalletRow[]> {
    return this.db.queryMany<OperationalConfigWalletRow>(
      `SELECT w.id AS wallet_record_id, w.custody_config_id, c.provider,
              w.wallet_id, w.public_key AS wallet_public_key,
              w.label AS wallet_label, w.purpose AS wallet_purpose,
              w.created_at AS wallet_created_at
       FROM custody_wallets w
       JOIN custody_configs c ON c.id = w.custody_config_id
       WHERE c.organization_id = ?
         AND c.status = 'active'
         AND w.status = 'active'
         AND ${projectId ? "(c.project_id = ? OR c.project_id IS NULL)" : "c.project_id IS NULL"}
       ORDER BY c.updated_at DESC, c.id DESC, w.created_at ASC`,
      projectId ? [organizationId, projectId] : [organizationId]
    );
  }

  private async findOperationalConnectionWallets(
    organizationId: string,
    projectId: string
  ): Promise<OperationalConnectionWalletRow[]> {
    return this.db.queryMany<OperationalConnectionWalletRow>(
      `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              pc.status AS credential_status, c.provider_account_fingerprint,
              c.default_custody_wallet_id,
              default_wallet.wallet_id AS default_wallet_id,
              default_wallet.public_key AS default_wallet_public_key,
              default_wallet.status AS default_wallet_status,
              w.id AS wallet_record_id, w.wallet_id,
              w.public_key AS wallet_public_key, w.status AS wallet_status,
              w.label AS wallet_label, w.purpose AS wallet_purpose,
              w.created_at AS wallet_created_at
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       JOIN custody_wallets w ON w.custody_connection_id = c.id
       LEFT JOIN custody_wallets default_wallet
         ON default_wallet.id = c.default_custody_wallet_id
        AND default_wallet.custody_connection_id = c.id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.status = 'active'
         AND w.status = 'active'
       ORDER BY c.updated_at DESC, c.id DESC, w.created_at ASC`,
      [organizationId, projectId]
    );
  }

  private mapOperationalConfigWallet(
    row: OperationalConfigWalletRow,
    effective: CustodyRuntimeTarget | null
  ): CustodyRuntimeWalletProjection {
    return {
      id: row.wallet_record_id,
      custodyConfigId: row.custody_config_id,
      provider: this.parseProvider(row.provider),
      isDefaultProvider:
        effective?.kind === "config" && effective.config.id === row.custody_config_id,
      isRuntimeExecutionAllowed: true,
      walletId: row.wallet_id,
      publicKey: row.wallet_public_key,
      label: row.wallet_label,
      purpose: row.wallet_purpose,
      status: "active",
      createdAt: row.wallet_created_at,
    };
  }

  private mapOperationalConnectionWallet(
    row: OperationalConnectionWalletRow,
    effective: CustodyRuntimeTarget | null
  ): CustodyRuntimeWalletProjection {
    return {
      id: row.wallet_record_id,
      custodyConnectionId: row.connection_id,
      provider: this.parseProvider(row.provider),
      isDefaultProvider:
        effective?.kind === "connection" && effective.connectionId === row.connection_id,
      isRuntimeExecutionAllowed: this.isConnectionRuntimeAvailable(row),
      walletId: row.wallet_id,
      publicKey: row.wallet_public_key,
      label: row.wallet_label,
      purpose: row.wallet_purpose,
      status: "active",
      createdAt: row.wallet_created_at,
    };
  }

  private isConnectionRuntimeAvailable(row: ConnectionTargetRow): boolean {
    const provider = this.parseProvider(row.provider);
    return (
      isCustodyConnectionRuntimeEnabled(this.env, provider) &&
      row.connection_status === "active" &&
      row.last_check_status === "success" &&
      row.credential_status === "active" &&
      row.provider_account_fingerprint !== null &&
      row.wallet_status === "active" &&
      row.default_custody_wallet_id !== null &&
      row.default_wallet_id !== null &&
      row.default_wallet_public_key !== null &&
      row.default_wallet_status === "active"
    );
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
      | "provider_account_mismatch"
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

function walletBelongsToTarget(
  wallet: CustodyRuntimeWalletProjection,
  target: CustodyRuntimeTarget
): boolean {
  return target.kind === "config"
    ? wallet.custodyConfigId === target.config.id
    : wallet.custodyConnectionId === target.connectionId;
}

function sortRuntimeWallets(
  wallets: CustodyRuntimeWalletProjection[]
): CustodyRuntimeWalletProjection[] {
  return wallets.sort(
    (left, right) =>
      Number(right.isDefaultProvider) - Number(left.isDefaultProvider) ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id)
  );
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

export async function selectCustodyConnectionTarget(
  db: DatabaseClient,
  env: Env,
  params: {
    organizationId: string;
    projectId: string;
    connectionId: string;
    provider?: CustodyProvider;
  }
): Promise<CustodyConnectionSelectionResult> {
  return db.transaction(async (tx) => {
    const project = await tx.queryOne<{ id: string }>(
      `SELECT id FROM projects
       WHERE id = ? AND organization_id = ? AND status = 'active'
       FOR UPDATE`,
      [params.projectId, params.organizationId]
    );
    if (!project) {
      throw notFound("Custody Connection");
    }

    const connection = await tx.queryOne<SelectableConnectionRow>(
      `SELECT c.id, c.provider, c.status, c.last_check_status,
              c.provider_account_fingerprint,
              c.default_custody_wallet_id, pc.status AS credential_status
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       WHERE c.id = ?
         AND c.organization_id = ?
         AND c.project_id = ?
       FOR UPDATE OF c, pc`,
      [params.connectionId, params.organizationId, params.projectId]
    );
    if (!connection) {
      throw notFound("Custody Connection");
    }

    const provider = parseCustodyProvider(connection.provider);
    if (params.provider && params.provider !== provider) {
      throw badRequest("Provider does not match Custody Connection");
    }
    if (!isCustodyConnectionRuntimeEnabled(env, provider)) {
      throw forbidden("Custody Connection runtime is disabled");
    }

    const wallet = connection.default_custody_wallet_id
      ? await tx.queryOne<{ wallet_id: string; public_key: string; status: string }>(
          `SELECT wallet_id, public_key, status
           FROM custody_wallets
           WHERE id = ? AND custody_connection_id = ?
           FOR UPDATE`,
          [connection.default_custody_wallet_id, connection.id]
        )
      : null;
    if (
      connection.status !== "active" ||
      connection.last_check_status !== "success" ||
      connection.credential_status !== "active" ||
      connection.provider_account_fingerprint === null ||
      wallet?.status !== "active"
    ) {
      throw conflict("Custody Connection is unavailable");
    }

    const scopeDefault = await findProjectScopeDefault(
      tx,
      params.organizationId,
      params.projectId,
      true
    );
    if (scopeDefault) {
      await tx.execute(
        `UPDATE custody_scope_defaults
         SET default_custody_connection_id = ?, updated_at = sdp_iso_now()
         WHERE id = ?`,
        [connection.id, scopeDefault.id]
      );
    } else {
      await tx.execute(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id, default_custody_connection_id
         ) VALUES (?, ?, ?, ?)`,
        [`csd_${crypto.randomUUID()}`, params.organizationId, params.projectId, connection.id]
      );
    }

    return {
      connectionId: connection.id,
      provider,
      walletId: wallet.wallet_id,
      publicKey: wallet.public_key,
    };
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
                 pc.status AS credential_status, c.provider_account_fingerprint,
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
    row.provider_account_fingerprint !== null &&
    row.default_wallet_id !== null &&
    row.default_wallet_status === "active"
  );
}

function parseCustodyProvider(provider: string): CustodyProvider {
  if (CUSTODY_PROVIDERS.includes(provider as CustodyProvider)) {
    return provider as CustodyProvider;
  }
  throw internalError("Custody Connection provider is invalid");
}
