import { CUSTODY_PROVIDERS, type CustodyProvider, normalizePrivyWalletId } from "@sdp/custody";
import { isFullSigningPort, SigningError, type SigningPort } from "@sdp/custody/signing";
import type {
  CustodyConfigStatus,
  CustodyConnectionCheckStatus,
  CustodyConnectionLifecycle,
  CustodyMode,
  CustodyWalletPurpose,
  CustodyWalletStatus,
  OrganizationProviderAvailabilityResponse,
  ProviderCredentialStatus,
} from "@sdp/types";
import { SDP_RAMP_PROVIDER_STAGES } from "@sdp/types";
import type { Address, TransactionSigner } from "@solana/kit";
import type { Context } from "hono";
import type { DatabaseClient } from "@/db";
import { AppError, conflict, internalError, notFound, providerUnavailable } from "@/lib/errors";
import { isCustodyProviderAvailable } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import type { SigningConfigRecord } from "@/services/adapters";
import { AuditService } from "@/services/audit.service";
import {
  type CredentialSecretStorageBackend,
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import { provisionPrivyWallet } from "@/services/custody/provisioning";
import { assertCustodyProviderCanCreateWallet } from "@/services/custody-provider-lifecycle.service";
import { createPrivyAdapterFromCredential } from "@/services/domain/signing/provider-adapter-factory";
import {
  assertCustodyProviderEntitled,
  custodyProviderNotInReleaseChannel,
  getProviderAvailability,
  isCustodyProviderEntitled,
} from "@/services/provider-availability.service";
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
  isRuntimeAvailable: boolean;
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
  isRuntimeExecutionAllowed: boolean;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: CustodyWalletPurpose | null;
  status: "active";
  createdAt: string;
} & (
  | { custodyConfigId: string; custodyConnectionId?: never }
  | { custodyConfigId?: never; custodyConnectionId: string }
);

export type CustodyRuntimeTargetQuery =
  | {
      kind: "wallet";
      organizationId: string;
      projectId: string;
      walletId: string;
    }
  | {
      kind: "wallet_record";
      organizationId: string;
      projectId: string;
      custodyWalletId: string;
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
  status: CustodyConfigStatus;
  created_at: string;
  updated_at: string;
}

interface ConfigWalletRow extends ConfigRow {
  wallet_id: string;
  wallet_public_key: string;
  wallet_status: string;
}

export interface CustodyConnectionRuntimeAvailabilityFacts {
  connection_status: CustodyConnectionLifecycle;
  last_check_status: CustodyConnectionCheckStatus | null;
  credential_status: ProviderCredentialStatus;
  provider_account_fingerprint: string | null;
}

interface ConnectionOwnerRow extends CustodyConnectionRuntimeAvailabilityFacts {
  connection_id: string;
  organization_id: string;
  project_id: string;
  provider: string;
}

interface ConnectionWalletRow extends ConnectionOwnerRow {
  wallet_id: string;
  wallet_public_key: string;
  wallet_status: CustodyWalletStatus;
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

interface OperationalConnectionWalletRow extends ConnectionWalletRow {
  wallet_record_id: string;
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
  provider_credential_id: string;
  credential_status: string;
  provider_account_fingerprint: string | null;
  request_delay_ms: number | null;
  credential_version: number;
  storage_backend: CredentialSecretStorageBackend;
  secret_ref: string | null;
  secret_version_ref: string | null;
  encrypted_secret_payload: string | null;
}

interface LockedConnectionWalletCreationRow {
  provider_credential_id: string;
  provider_credential_scope_key: string;
  status: string;
  last_check_status: string | null;
  provider_account_fingerprint: string | null;
}

interface LockedCredentialWalletCreationRow {
  status: string;
}

interface CreatedConnectionWalletRow {
  id: string;
  wallet_id: string;
  public_key: string;
  label: string | null;
  purpose: CustodyWalletPurpose | null;
  created_at: string;
}

/**
 * Whether a custody connection can sign right now: its (provider, byok) pair is in
 * the release channel, the connection itself is active with a successful check and
 * a reserved provider account, and its credential is active. No wallet of the
 * connection is privileged; each wallet adds only its own status on top.
 *
 * @param env - Process environment naming the release channel.
 * @param provider - The connection's custody provider.
 * @param row - The connection's lifecycle and credential facts.
 * @returns True when the connection's wallets may execute.
 */
export function isCustodyConnectionRuntimeAvailable(
  env: Pick<Env, "SDP_RELEASE_CHANNEL">,
  provider: CustodyProvider,
  row: CustodyConnectionRuntimeAvailabilityFacts
): boolean {
  return (
    isCustodyProviderAvailable(env, provider, "byok") &&
    row.connection_status === "active" &&
    row.last_check_status === "success" &&
    row.credential_status === "active" &&
    row.provider_account_fingerprint !== null
  );
}

const RUNTIME_EXECUTION_UNAVAILABLE_REASON = "runtime_execution_unavailable";

export class CustodyRuntimeTargets {
  constructor(
    private readonly db: DatabaseClient,
    private readonly env: Env,
    private readonly adapterCache: Map<string, SigningPort>
  ) {}

  async resolve(query: CustodyRuntimeTargetQuery): Promise<CustodyRuntimeTarget | null> {
    switch (query.kind) {
      case "wallet":
        return this.resolveWallet(query.organizationId, query.projectId, query.walletId);
      case "wallet_record":
        return this.resolveWalletRecord(
          query.organizationId,
          query.projectId,
          query.custodyWalletId
        );
      case "connection":
        return this.resolveConnection(query.organizationId, query.projectId, query.connectionId);
      default: {
        const unhandled: never = query;
        return unhandled;
      }
    }
  }

  async admitRuntimeExecution(params: {
    organizationId: string;
    projectId: string;
    custodyWalletId: string;
  }): Promise<void> {
    const target = await this.resolveRetainedWalletRecord(
      params.organizationId,
      params.projectId,
      params.custodyWalletId
    );
    if (!target) {
      this.logMissingExactWallet(params);
      throw notFound("Custody wallet");
    }
    this.assertRuntimeExecutionAllowed(target, params.custodyWalletId);
    await assertCustodyProviderEntitled(this.env, this.db, params.organizationId, target.provider);
  }

  /**
   * Every operational wallet of the project across both owner kinds, oldest first
   * with ID as a tie-break, optionally narrowed to one provider.
   *
   * @param params - The project scope and optional provider filter.
   * @param params.organizationId - The organization that owns the project.
   * @param params.projectId - The project whose wallets are listed.
   * @param params.provider - Narrows the list to one custody provider when set.
   * @returns The project's active wallets with their runtime-execution flags.
   */
  async listWallets(params: {
    organizationId: string;
    projectId: string;
    provider?: CustodyProvider;
  }): Promise<CustodyRuntimeWalletProjection[]> {
    const [configRows, connectionRows, availability] = await Promise.all([
      this.findOperationalConfigWallets(params.organizationId, params.projectId),
      this.findOperationalConnectionWallets(params.organizationId, params.projectId),
      // Custody entries only: ramp provider stages cannot change them.
      getProviderAvailability(this.env, this.db, params.organizationId, {
        rampProviderStages: SDP_RAMP_PROVIDER_STAGES,
      }),
    ]);
    const wallets = [
      ...configRows.map((row) => this.mapOperationalConfigWallet(row, availability)),
      ...connectionRows.map((row) => this.mapOperationalConnectionWallet(row, availability)),
    ].filter((wallet) => !params.provider || wallet.provider === params.provider);

    return sortRuntimeWallets(wallets);
  }

  async findOperationalWallet(params: {
    organizationId: string;
    projectId: string;
    walletId: string;
    allowRecordIdAlias?: boolean;
  }): Promise<CustodyRuntimeWalletProjection | null> {
    const wallets = await this.listWallets({
      organizationId: params.organizationId,
      projectId: params.projectId,
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

  async findOperationalWalletById(params: {
    organizationId: string;
    projectId: string;
    custodyWalletId: string;
  }): Promise<CustodyRuntimeWalletProjection | null> {
    const wallets = await this.listWallets({
      organizationId: params.organizationId,
      projectId: params.projectId,
    });
    return wallets.find((wallet) => wallet.id === params.custodyWalletId) ?? null;
  }

  /**
   * Every active custody wallet holding an on-chain address, oldest first with ID as a tie-break —
   * an indexed read (`idx_custody_wallets_public_key`) over both ownership
   * paths with the same active/org/project filters as {@link listWallets}.
   * Multiple records can hold one address, so callers pick.
   */
  async findOperationalWalletIdsByAddress(params: {
    organizationId: string;
    projectId: string;
    publicKey: string;
  }): Promise<string[]> {
    const wallets = await this.findOperationalWalletIdsByAddresses({
      organizationId: params.organizationId,
      projectId: params.projectId,
      publicKeys: [params.publicKey],
    });
    return wallets.get(params.publicKey) ?? [];
  }

  /** Batch equivalent of {@link findOperationalWalletIdsByAddress}, oldest first per address. */
  async findOperationalWalletIdsByAddresses(params: {
    organizationId: string;
    projectId: string;
    publicKeys: readonly string[];
  }): Promise<Map<string, string[]>> {
    const wallets = new Map<string, string[]>();
    if (params.publicKeys.length === 0) return wallets;

    const rows = await this.db.queryMany<{ id: string; public_key: string }>(
      `SELECT w.id, w.public_key
         FROM custody_wallets w
         LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
         LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
        WHERE w.public_key = ANY(?::text[])
          AND w.status = 'active'
          AND (
            (cfg.id IS NOT NULL AND cfg.organization_id = ? AND cfg.status = 'active'
               AND cfg.project_id = ?)
            OR
            (conn.id IS NOT NULL AND conn.organization_id = ? AND conn.project_id = ?
               AND conn.status = 'active')
          )
        ORDER BY w.created_at ASC, w.id ASC`,
      [
        params.publicKeys,
        params.organizationId,
        params.projectId,
        params.organizationId,
        params.projectId,
      ]
    );
    for (const row of rows) {
      const ids = wallets.get(row.public_key);
      if (ids) ids.push(row.id);
      else wallets.set(row.public_key, [row.id]);
    }
    return wallets;
  }

  async findOwnedWalletForMutation(params: {
    organizationId: string;
    projectId: string;
    walletId: string;
    /** Include retained address aliases when checking source-selector ambiguity. */
    publicKey?: string;
  }): Promise<CustodyOwnedWallet | null> {
    const selector = params.publicKey ? "(w.wallet_id = ? OR w.public_key = ?)" : "w.wallet_id = ?";
    const selectorValues = params.publicKey
      ? [params.walletId, params.publicKey]
      : [params.walletId];
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
           AND c.project_id = ?
           AND ${selector}`,
        [params.organizationId, params.projectId, ...selectorValues]
      ),
      this.db.queryMany<{
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
           AND ${selector}`,
        [params.organizationId, params.projectId, ...selectorValues]
      ),
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
    auditContext: Context<{ Bindings: Env }>;
    creationReason: "wallet_api" | "api_key" | "dvp_settlement_authority";
    organizationId: string;
    projectId: string;
    connectionId: string;
    label?: string;
    purpose?: CustodyWalletPurpose;
  }): Promise<CreatedCustodyConnectionWallet> {
    const target = await this.resolveConnection(
      params.organizationId,
      params.projectId,
      params.connectionId
    );
    if (!target) {
      throw notFound("Custody Connection");
    }
    assertCustodyProviderCanCreateWallet(target.provider);
    this.assertTargetInReleaseChannel(target);
    if (!target.isRuntimeAvailable) {
      throw conflict("Custody Connection is unavailable");
    }

    await assertCustodyProviderEntitled(this.env, this.db, params.organizationId, target.provider);

    const credential = await this.loadConnectionCredential(target);
    if (!credential || !isUsableCredentialOwner(credential)) {
      throw conflict("Custody Connection is unavailable");
    }
    if (target.provider !== "privy") {
      throw internalError("Custody Connection provider is unsupported");
    }

    const authentication = await this.readPrivyCredential(target, credential);
    const custodyWalletId = `cwlt_${crypto.randomUUID()}`;
    const audit = new AuditService(this.db);
    const intent = await audit.beginCritical(params.auditContext, {
      action: "create",
      resourceType: "custody_wallet",
      resourceId: custodyWalletId,
      metadata: {
        event: "custody_wallet_created",
        projectId: target.projectId,
        provider: target.provider,
        connectionId: target.connectionId,
        custodyWalletId,
        creationReason: params.creationReason,
      },
    });
    let provisioned: { walletId: string; address: string };
    try {
      provisioned = await provisionPrivyWallet(
        this.env,
        { credentialRequest: true },
        authentication
      );
    } catch (error) {
      if (!(error instanceof SigningError) || error.code === "NETWORK_ERROR") {
        // Keep the intent unresolved: the Provider may have created the wallet.
        this.logWalletOrphanRisk(target, "provider_result_unknown", intent.id);
      } else {
        await audit.completeCritical(params.auditContext, intent, {
          status: "failure",
          metadata: { result: "failed", reason: "provider_rejected" },
        });
      }
      throw providerUnavailable("Custody provider is temporarily unavailable");
    }

    const providerWalletId = normalizePrivyWalletId(provisioned.walletId);
    let persisted: CreatedCustodyConnectionWallet;
    try {
      persisted = await this.persistConnectionWallet(target, credential, {
        id: custodyWalletId,
        walletId: providerWalletId,
        publicKey: provisioned.address,
        label: params.label,
        purpose: params.purpose,
      });
    } catch (error) {
      // A failed/ambiguous commit cannot prove the Provider wallet was persisted.
      this.logWalletOrphanRisk(target, "persistence_failed", intent.id, providerWalletId);
      if (error instanceof AppError && error.code === "CONFLICT") {
        throw error;
      }
      throw internalError("Failed to complete wallet creation");
    }
    await audit.completeCritical(params.auditContext, intent, {
      metadata: {
        result: "created",
        walletId: persisted.walletId,
      },
    });
    return persisted;
  }

  /**
   * Resolve a signer from the exact custody-wallet row authorized by the
   * caller. Provider wallet ids are not unique across a project's retained
   * Config and Connection targets, so money-moving flows that already hold a
   * row id must not collapse it back to `walletId` before signing.
   */
  async getTransactionSignerForWalletRecord(
    organizationId: string,
    projectId: string,
    custodyWalletId: string,
    getConfigAdapter: ConfigAdapterResolver
  ): Promise<TransactionSigner> {
    const target = await this.resolveRetainedWalletRecord(
      organizationId,
      projectId,
      custodyWalletId
    );
    if (!target) {
      this.logMissingExactWallet({ organizationId, projectId, custodyWalletId });
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
    this.assertRuntimeExecutionAllowed(target, custodyWalletId);
    await assertCustodyProviderEntitled(this.env, this.db, organizationId, target.provider);

    if (target.kind === "config") {
      const adapter = await getConfigAdapter(organizationId, target.config);
      const signer = await getTransactionSigner(adapter, target.wallet);
      this.assertSignerMatchesWallet(target, signer, custodyWalletId);
      return signer;
    }

    const adapter = await this.getConnectionAdapter(target, target.wallet);
    const signer = await getTransactionSigner(adapter, target.wallet);
    this.assertSignerMatchesWallet(target, signer, custodyWalletId);
    return signer;
  }

  private async resolveConnection(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<ConnectionRuntimeTarget | null> {
    const row = await this.db.queryOne<ConnectionOwnerRow>(
      `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              pc.status AS credential_status, c.provider_account_fingerprint
       FROM custody_connections c
       JOIN provider_credentials pc
         ON pc.id = c.provider_credential_id
        AND pc.project_id = c.project_id
       WHERE c.id = ?
         AND c.organization_id = ?
         AND c.project_id = ?
       LIMIT 1`,
      [connectionId, organizationId, projectId]
    );
    return row ? this.mapConnectionOwnerTarget(row) : null;
  }

  private async resolveWallet(
    organizationId: string,
    projectId: string,
    walletId: string
  ): Promise<CustodyRuntimeTarget | null> {
    const [connections, configs] = await Promise.all([
      this.db.queryMany<ConnectionWalletRow>(
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
      return this.mapConnectionWalletTarget(connections[0]);
    }
    if (configs[0]) {
      return this.mapConfigWalletTarget(configs[0]);
    }
    return null;
  }

  private async resolveWalletRecord(
    organizationId: string,
    projectId: string,
    custodyWalletId: string
  ): Promise<CustodyRuntimeTarget | null> {
    const [connections, configs] = await Promise.all([
      this.db.queryMany<ConnectionWalletRow>(
        `${connectionTargetSelect()}
         WHERE c.organization_id = ?
           AND c.project_id = ?
           AND c.status = 'active'
           AND w.status = 'active'
           AND w.id = ?`,
        [organizationId, projectId, custodyWalletId]
      ),
      this.db.queryMany<ConfigWalletRow>(
        `${configWalletSelect()}
         WHERE c.organization_id = ?
           AND c.project_id = ?
           AND c.status = 'active'
           AND w.status = 'active'
           AND w.id = ?`,
        [organizationId, projectId, custodyWalletId]
      ),
    ]);

    if (connections.length + configs.length > 1) {
      throw conflict("Custody wallet ownership is ambiguous");
    }
    if (connections[0]) return this.mapConnectionWalletTarget(connections[0]);
    if (configs[0]) return this.mapConfigWalletTarget(configs[0]);
    return null;
  }

  private async resolveRetainedWalletRecord(
    organizationId: string,
    projectId: string,
    custodyWalletId: string
  ): Promise<CustodyRuntimeTarget | null> {
    const [connections, configs] = await Promise.all([
      this.db.queryMany<ConnectionWalletRow>(
        `${connectionTargetSelect()}
         WHERE c.organization_id = ?
           AND c.project_id = ?
           AND w.id = ?`,
        [organizationId, projectId, custodyWalletId]
      ),
      this.db.queryMany<ConfigWalletRow>(
        `${configWalletSelect()}
         WHERE c.organization_id = ?
           AND c.project_id = ?
           AND w.id = ?`,
        [organizationId, projectId, custodyWalletId]
      ),
    ]);

    if (connections.length + configs.length > 1) {
      throw conflict("Custody wallet ownership is ambiguous");
    }
    if (connections[0]) return this.mapConnectionWalletTarget(connections[0]);
    if (configs[0]) return this.mapConfigWalletTarget(configs[0]);
    return null;
  }

  private async getConnectionAdapter(
    target: ConnectionRuntimeTarget,
    wallet: RuntimeWallet
  ): Promise<SigningPort> {
    const row = await this.loadConnectionCredential(target);
    if (!row || !isUsableCredentialOwner(row)) {
      this.logUnavailable(target, "connection_changed");
      throw conflict("Custody Connection is unavailable", {
        reason: RUNTIME_EXECUTION_UNAVAILABLE_REASON,
      });
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
      wallet.walletId,
      row.request_delay_ms ?? "env",
    ].join(":");
    const cached = this.adapterCache.get(cacheKey);
    if (cached) {
      return cached;
    }

    const secret = await this.readPrivyCredential(target, row);
    const adapter = createPrivyAdapterFromCredential(this.env, {
      ...secret,
      walletId: wallet.walletId,
      requestDelayMs: row.request_delay_ms ?? undefined,
    });
    this.adapterCache.set(cacheKey, adapter);
    return adapter;
  }

  private async loadConnectionCredential(
    target: ConnectionRuntimeTarget
  ): Promise<ConnectionCredentialRow | null> {
    return this.db.queryOne<ConnectionCredentialRow>(
      `SELECT c.id AS connection_id, c.provider,
              c.status AS connection_status, c.last_check_status,
              c.provider_account_fingerprint, c.request_delay_ms,
              pc.id AS provider_credential_id,
              pc.status AS credential_status,
              pc.credential_version, pc.storage_backend,
              pc.secret_ref, pc.secret_version_ref, pc.encrypted_secret_payload
       FROM custody_connections c
       JOIN provider_credentials pc
         ON pc.id = c.provider_credential_id
        AND pc.project_id = c.project_id
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
      id: string;
      walletId: string;
      publicKey: string;
      label?: string;
      purpose?: CustodyWalletPurpose;
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
        `SELECT provider_credential_id, provider_credential_scope_key, status, last_check_status,
                provider_account_fingerprint
         FROM custody_connections
         WHERE id = ? AND organization_id = ? AND project_id = ?
         FOR UPDATE`,
        [target.connectionId, target.organizationId, target.projectId]
      );
      if (!connection) {
        throw conflict("Custody Connection changed during wallet creation");
      }

      // A Privy wallet belongs to the Provider account, not one Credential
      // version. Rotation and rollback may change the pointer while the
      // Provider request is in flight, so re-lock the current scoped
      // Credential and rely on the unchanged account fingerprint above.
      const currentCredential = await tx.queryOne<LockedCredentialWalletCreationRow>(
        `SELECT status
         FROM provider_credentials
         WHERE id = ?
           AND organization_id = ?
           AND provider = ?
           AND scope_key = ?
           AND project_id = ?
         FOR UPDATE`,
        [
          connection.provider_credential_id,
          target.organizationId,
          target.provider,
          connection.provider_credential_scope_key,
          target.projectId,
        ]
      );
      if (
        connection.status !== "active" ||
        connection.last_check_status !== "success" ||
        connection.provider_account_fingerprint !== credential.provider_account_fingerprint ||
        currentCredential?.status !== "active"
      ) {
        throw conflict("Custody Connection changed during wallet creation");
      }

      const created = await tx.queryOne<CreatedConnectionWalletRow>(
        `INSERT INTO custody_wallets (
           id, custody_config_id, custody_connection_id, wallet_id,
           public_key, label, purpose, status, updated_at
         ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'active', sdp_iso_now())
         RETURNING id, wallet_id, public_key, label, purpose, created_at`,
        [
          wallet.id,
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
    auditIntentId: string,
    walletId?: string
  ): void {
    getLogger().error(
      {
        organizationId: target.organizationId,
        projectId: target.projectId,
        connectionId: target.connectionId,
        provider: target.provider,
        reason,
        auditIntentId,
        walletId,
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
      isRuntimeAvailable: row.status === "active",
    };
  }

  private mapConfigWalletTarget(row: ConfigWalletRow): ConfigRuntimeTarget {
    return {
      ...this.mapConfigTarget(row),
      wallet: {
        walletId: row.wallet_id,
        publicKey: row.wallet_public_key as Address,
      },
      isRuntimeAvailable: row.status === "active" && row.wallet_status === "active",
    };
  }

  /**
   * Refuses a target whose (provider, custody mode) pair the release channel
   * leaves out. A config is Managed custody, a connection is BYOK.
   *
   * @param target - The custody target about to execute.
   * @param custodyWalletId - The wallet row the caller named, for the refusal log.
   * @throws 403 when the pair is outside the release channel.
   */
  private assertTargetInReleaseChannel(
    target: CustodyRuntimeTarget,
    custodyWalletId?: string
  ): void {
    const mode: CustodyMode = target.kind === "config" ? "managed" : "byok";
    if (isCustodyProviderAvailable(this.env, target.provider, mode)) {
      return;
    }
    this.logUnavailable(target, "not_in_release_channel", custodyWalletId);
    throw custodyProviderNotInReleaseChannel(target.provider, mode);
  }

  private assertRuntimeExecutionAllowed(
    target: CustodyRuntimeTarget,
    custodyWalletId: string
  ): asserts target is CustodyRuntimeTarget & { wallet: RuntimeWallet } {
    this.assertTargetInReleaseChannel(target, custodyWalletId);
    if (target.kind === "config") {
      if (!target.isRuntimeAvailable || !target.wallet) {
        this.logUnavailable(target, RUNTIME_EXECUTION_UNAVAILABLE_REASON, custodyWalletId);
        throw conflict("Custody wallet is unavailable", {
          reason: RUNTIME_EXECUTION_UNAVAILABLE_REASON,
        });
      }
      return;
    }

    if (!target.isRuntimeAvailable || !target.wallet) {
      this.logUnavailable(target, "connection_unusable", custodyWalletId);
      throw conflict("Custody Connection is unavailable", {
        reason: RUNTIME_EXECUTION_UNAVAILABLE_REASON,
      });
    }
  }

  private assertSignerMatchesWallet(
    target: CustodyRuntimeTarget,
    signer: TransactionSigner,
    custodyWalletId: string
  ): void {
    if (target.wallet && signer.address === target.wallet.publicKey) {
      return;
    }

    getLogger().error(
      {
        organizationId:
          target.kind === "config" ? target.config.organizationId : target.organizationId,
        projectId: target.kind === "config" ? target.config.projectId : target.projectId,
        provider: target.provider,
        targetKind: target.kind,
        targetId: target.kind === "config" ? target.config.id : target.connectionId,
        custodyWalletId,
        reason: "signer_address_mismatch",
      },
      "custody_runtime_target_unexpected"
    );
    throw conflict("Custody signer does not match the selected wallet", {
      reason: RUNTIME_EXECUTION_UNAVAILABLE_REASON,
    });
  }

  private mapConnectionOwnerTarget(row: ConnectionOwnerRow): ConnectionRuntimeTarget {
    return {
      kind: "connection",
      provider: this.parseProvider(row.provider),
      organizationId: row.organization_id,
      projectId: row.project_id,
      connectionId: row.connection_id,
      wallet: null,
      isRuntimeAvailable: this.isConnectionRuntimeAvailable(row),
    };
  }

  private mapConnectionWalletTarget(row: ConnectionWalletRow): ConnectionRuntimeTarget {
    return {
      ...this.mapConnectionOwnerTarget(row),
      wallet: {
        walletId: row.wallet_id,
        publicKey: row.wallet_public_key as Address,
      },
      isRuntimeAvailable: this.isConnectionRuntimeAvailable(row) && row.wallet_status === "active",
    };
  }

  private async findOperationalConfigWallets(
    organizationId: string,
    projectId: string
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
         AND c.project_id = ?
       ORDER BY c.updated_at DESC, c.id DESC, w.created_at ASC`,
      [organizationId, projectId]
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
              w.id AS wallet_record_id, w.wallet_id,
              w.public_key AS wallet_public_key, w.status AS wallet_status,
              w.label AS wallet_label, w.purpose AS wallet_purpose,
              w.created_at AS wallet_created_at
       FROM custody_connections c
       JOIN provider_credentials pc
         ON pc.id = c.provider_credential_id
        AND pc.project_id = c.project_id
       JOIN custody_wallets w ON w.custody_connection_id = c.id
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
    availability: OrganizationProviderAvailabilityResponse
  ): CustodyRuntimeWalletProjection {
    const provider = this.parseProvider(row.provider);
    return {
      id: row.wallet_record_id,
      custodyConfigId: row.custody_config_id,
      provider,
      isRuntimeExecutionAllowed:
        isCustodyProviderAvailable(this.env, provider, "managed") &&
        isCustodyProviderEntitled(availability, provider),
      walletId: row.wallet_id,
      publicKey: row.wallet_public_key,
      label: row.wallet_label,
      purpose: parseWalletPurpose(row.wallet_purpose),
      status: "active",
      createdAt: row.wallet_created_at,
    };
  }

  private mapOperationalConnectionWallet(
    row: OperationalConnectionWalletRow,
    availability: OrganizationProviderAvailabilityResponse
  ): CustodyRuntimeWalletProjection {
    const provider = this.parseProvider(row.provider);
    return {
      id: row.wallet_record_id,
      custodyConnectionId: row.connection_id,
      provider,
      isRuntimeExecutionAllowed:
        this.isConnectionRuntimeAvailable(row) && isCustodyProviderEntitled(availability, provider),
      walletId: row.wallet_id,
      publicKey: row.wallet_public_key,
      label: row.wallet_label,
      purpose: parseWalletPurpose(row.wallet_purpose),
      status: "active",
      createdAt: row.wallet_created_at,
    };
  }

  private isConnectionRuntimeAvailable(row: ConnectionOwnerRow): boolean {
    return isCustodyConnectionRuntimeAvailable(this.env, this.parseProvider(row.provider), row);
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

  private logMissingExactWallet(params: {
    organizationId: string;
    projectId: string;
    custodyWalletId: string;
  }): void {
    getLogger().warn(
      {
        organizationId: params.organizationId,
        projectId: params.projectId,
        custodyWalletId: params.custodyWalletId,
        reason: "exact_wallet_not_found",
      },
      "custody_runtime_target_unavailable"
    );
  }

  private logUnavailable(
    target: CustodyRuntimeTarget,
    reason:
      | "not_in_release_channel"
      | "runtime_execution_unavailable"
      | "connection_unusable"
      | "connection_changed"
      | "credential_secret_unavailable",
    custodyWalletId?: string
  ): void {
    getLogger().warn(
      {
        organizationId:
          target.kind === "config" ? target.config.organizationId : target.organizationId,
        projectId: target.kind === "config" ? target.config.projectId : target.projectId,
        provider: target.provider,
        targetKind: target.kind,
        targetId: target.kind === "config" ? target.config.id : target.connectionId,
        custodyWalletId: custodyWalletId ?? null,
        reason,
      },
      "custody_runtime_target_unavailable"
    );
  }
}

/**
 * Every purpose a stored wallet may carry.
 *
 * Derived from the union rather than restated as switch cases, and that is the
 * point: this parser THROWS on anything it does not recognise, so a purpose
 * added to the type and written to a row took the entire wallet list down for
 * the project with "Unknown custody wallet purpose" — the list, the pickers
 * that read it, and every screen built on top.
 *
 * As a `satisfies` record, adding a purpose to `CustodyWalletPurpose` without
 * adding it here is a compile error rather than a runtime outage.
 */
const KNOWN_WALLET_PURPOSES = {
  root: true,
  mint_authority: true,
  freeze_authority: true,
  fee_payer: true,
  transfer: true,
  dvp_settlement_authority: true,
} as const satisfies Record<CustodyWalletPurpose, true>;

function parseWalletPurpose(purpose: string | null): CustodyWalletPurpose | null {
  if (purpose === null) {
    return null;
  }
  if (purpose in KNOWN_WALLET_PURPOSES) {
    return purpose as CustodyWalletPurpose;
  }
  // Still a throw: an unrecognised purpose is untrusted data in a signing path,
  // and guessing at it would let a row nobody wrote decide how a wallet is used.
  throw internalError("Unknown custody wallet purpose");
}

function sortRuntimeWallets(
  wallets: CustodyRuntimeWalletProjection[]
): CustodyRuntimeWalletProjection[] {
  return wallets.sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
  );
}

function getTransactionSigner(
  adapter: SigningPort,
  wallet: RuntimeWallet
): Promise<TransactionSigner> {
  if (!isFullSigningPort(adapter)) {
    throw new SigningError(
      `Provider does not support transaction signing: ${adapter.providerId}`,
      "INVALID_REQUEST"
    );
  }
  return adapter.getTransactionSigner(wallet.walletId, wallet.publicKey);
}

function connectionTargetSelect(): string {
  return `SELECT c.id AS connection_id, c.organization_id, c.project_id, c.provider,
                 c.status AS connection_status, c.last_check_status,
                 pc.status AS credential_status, c.provider_account_fingerprint,
                 w.wallet_id,
                 w.public_key AS wallet_public_key,
                 w.status AS wallet_status
          FROM custody_connections c
          JOIN provider_credentials pc
            ON pc.id = c.provider_credential_id
           AND pc.project_id = c.project_id
          JOIN custody_wallets w
            ON w.custody_connection_id = c.id`;
}

function configWalletSelect(): string {
  return `SELECT c.id, c.organization_id, c.project_id, c.provider,
                 c.config_encrypted, c.encryption_version,
                 c.status, c.created_at, c.updated_at,
                 w.wallet_id, w.public_key AS wallet_public_key,
                 w.status AS wallet_status
          FROM custody_configs c
          JOIN custody_wallets w ON w.custody_config_id = c.id`;
}

function mapConfig(row: ConfigRow, provider: CustodyProvider): SigningConfigRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    provider,
    config: row.config_encrypted,
    encryptionVersion: row.encryption_version,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUsableCredentialOwner(row: ConnectionCredentialRow): boolean {
  return (
    row.connection_status === "active" &&
    row.last_check_status === "success" &&
    row.credential_status === "active" &&
    row.provider_account_fingerprint !== null
  );
}
