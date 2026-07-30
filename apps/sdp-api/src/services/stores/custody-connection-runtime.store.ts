import { SigningError } from "@sdp/custody/signing";
import type { DatabaseClient, DatabaseExecutor } from "@/db";
import type { CredentialSecretStorageBackend } from "@/services/credential-secret-store";
import type { WalletPurpose } from "@/services/stores/custody-config.store";
import { CUSTODY_WALLET_OWNER_CTE } from "@/services/stores/custody-wallet-owner";

export type CustodyConnectionRuntimeStatus =
  | "pending"
  | "checking"
  | "active"
  | "failed"
  | "deactivated";

export interface CustodyConnectionRuntimeRecord {
  id: string;
  organizationId: string;
  projectId: string;
  provider: "privy";
  providerCredentialId: string;
  defaultCustodyWalletId: string | null;
  defaultWalletId: string | null;
  defaultWalletPublicKey: string | null;
  status: CustodyConnectionRuntimeStatus;
  lastCheckStatus: string | null;
  credentialStatus: "pending" | "active" | "failed_validation" | "retired" | "deactivated";
  credentialStorageBackend: CredentialSecretStorageBackend;
  credentialSecretRef: string | null;
  credentialSecretVersionRef: string | null;
  credentialEncryptedSecretPayload: string | null;
}

export function isUsableCustodyConnection(
  connection: CustodyConnectionRuntimeRecord
): connection is CustodyConnectionRuntimeRecord & {
  defaultCustodyWalletId: string;
  defaultWalletId: string;
} {
  return (
    connection.status === "active" &&
    connection.lastCheckStatus === "success" &&
    connection.credentialStatus === "active" &&
    connection.defaultCustodyWalletId !== null &&
    connection.defaultWalletId !== null
  );
}

export interface ConnectionCustodyWallet {
  id: string;
  walletId: string;
  publicKey: string;
  label: string | null;
  purpose: WalletPurpose | null;
  status: "active" | "inactive";
  createdAt: string;
}

interface WalletOwnerBase {
  ownerId: string;
  organizationId: string;
  projectId: string | null;
  provider: "privy" | string;
  ownerStatus: string;
  isSelected: boolean;
  wallet: ConnectionCustodyWallet;
}

export type CustodyWalletOwner =
  | (WalletOwnerBase & {
      kind: "config";
      custodyConfigId: string;
    })
  | (WalletOwnerBase & {
      kind: "connection";
      provider: "privy";
      projectId: string;
      connection: CustodyConnectionRuntimeRecord;
    });

interface ConnectionRow {
  id: string;
  organization_id: string;
  project_id: string;
  provider: "privy";
  provider_credential_id: string;
  default_custody_wallet_id: string | null;
  default_wallet_id: string | null;
  default_wallet_public_key: string | null;
  status: CustodyConnectionRuntimeStatus;
  last_check_status: string | null;
  credential_status: CustodyConnectionRuntimeRecord["credentialStatus"];
  storage_backend: CredentialSecretStorageBackend;
  secret_ref: string | null;
  secret_version_ref: string | null;
  encrypted_secret_payload: string | null;
}

interface WalletOwnerRow {
  id: string;
  custody_config_id: string | null;
  custody_connection_id: string | null;
  wallet_id: string;
  public_key: string;
  label: string | null;
  purpose: string | null;
  status: string;
  created_at: string;
  owner_kind: "config" | "connection";
  owner_id: string;
  organization_id: string;
  project_id: string | null;
  provider: string;
  owner_status: string;
  owner_usable: boolean;
  is_selected: boolean;
  provider_credential_id: string | null;
  default_custody_wallet_id: string | null;
  default_wallet_id: string | null;
  default_wallet_public_key: string | null;
  last_check_status: string | null;
  credential_status: CustodyConnectionRuntimeRecord["credentialStatus"] | null;
  storage_backend: CredentialSecretStorageBackend | null;
  secret_ref: string | null;
  secret_version_ref: string | null;
  encrypted_secret_payload: string | null;
}

export class CustodyConnectionRuntimeStore {
  constructor(
    private readonly db: DatabaseClient,
    private readonly enabledConnectionProviders: readonly CustodyConnectionRuntimeRecord["provider"][] = []
  ) {}

  async listProjectConnections(
    organizationId: string,
    projectId: string
  ): Promise<CustodyConnectionRuntimeRecord[]> {
    const rows = await this.db.queryMany<ConnectionRow>(
      `${connectionSelect()}
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.provider = 'privy'
         AND c.provider = ANY(?::text[])
       ORDER BY c.created_at, c.id`,
      [organizationId, projectId, this.enabledConnectionProviders]
    );
    return rows.map(mapConnection);
  }

  async getSelectedProjectConnection(
    organizationId: string,
    projectId: string
  ): Promise<CustodyConnectionRuntimeRecord | null> {
    const row = await this.db.queryOne<ConnectionRow>(
      `${connectionSelect()}
       JOIN custody_scope_defaults d
         ON d.default_custody_connection_id = c.id
        AND d.organization_id = c.organization_id
        AND d.project_id = c.project_id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.provider = ANY(?::text[])
       LIMIT 1`,
      [organizationId, projectId, this.enabledConnectionProviders]
    );
    return row ? mapConnection(row) : null;
  }

  async listConnectionWallets(
    organizationId: string,
    projectId: string,
    connectionId?: string
  ): Promise<Array<ConnectionCustodyWallet & { connectionId: string }>> {
    const rows = await this.db.queryMany<WalletOwnerRow>(
      `WITH ${CUSTODY_WALLET_OWNER_CTE}
       SELECT o.*, FALSE AS is_selected,
              NULL::text AS provider_credential_id,
              NULL::text AS default_custody_wallet_id,
              NULL::text AS default_wallet_id,
              NULL::text AS default_wallet_public_key,
              NULL::text AS last_check_status,
              NULL::text AS credential_status,
              NULL::text AS storage_backend,
              NULL::text AS secret_ref,
              NULL::text AS secret_version_ref,
              NULL::text AS encrypted_secret_payload
       FROM custody_wallet_owners o
       WHERE o.owner_kind = 'connection'
         AND o.organization_id = ?
         AND o.project_id = ?
         AND o.provider = ANY(?::text[])
         AND o.owner_usable
         AND o.status = 'active'
         ${connectionId ? "AND o.owner_id = ?" : ""}
       ORDER BY o.created_at, o.id`,
      connectionId
        ? [organizationId, projectId, this.enabledConnectionProviders, connectionId]
        : [organizationId, projectId, this.enabledConnectionProviders]
    );

    return rows.map((row) => ({
      ...mapWallet(row),
      connectionId: row.owner_id,
    }));
  }

  async findWalletOwner(
    organizationId: string,
    projectId: string | undefined,
    walletIdentifier: string
  ): Promise<CustodyWalletOwner | null> {
    return this.findWalletOwnerMatching(
      organizationId,
      projectId,
      "(o.id = ? OR o.wallet_id = ?)",
      [walletIdentifier, walletIdentifier],
      walletIdentifier
    );
  }

  async findWalletOwnerByPublicKey(
    organizationId: string,
    projectId: string | undefined,
    publicKey: string
  ): Promise<CustodyWalletOwner | null> {
    return this.findWalletOwnerMatching(organizationId, projectId, "o.public_key = ?", [publicKey]);
  }

  private async findWalletOwnerMatching(
    organizationId: string,
    projectId: string | undefined,
    ownerPredicate: "(o.id = ? OR o.wallet_id = ?)" | "o.public_key = ?",
    ownerParams: string[],
    preferredCustodyWalletId?: string
  ): Promise<CustodyWalletOwner | null> {
    const rows = await this.db.queryMany<WalletOwnerRow>(
      `WITH ${CUSTODY_WALLET_OWNER_CTE},
       connection_policy AS (
         SELECT ?::text[] AS enabled_providers
       )
       SELECT
         o.*,
         CASE
           WHEN o.owner_kind = 'connection'
             THEN project_default.default_custody_connection_id = o.owner_id
           WHEN selected_connection.provider = ANY(policy.enabled_providers)
             THEN FALSE
           WHEN project_default.default_custody_config_id IS NOT NULL
             THEN project_default.default_custody_config_id = o.owner_id
           ELSE organization_default.default_custody_config_id = o.owner_id
         END AS is_selected,
         c.provider_credential_id,
         c.default_custody_wallet_id,
         default_wallet.wallet_id AS default_wallet_id,
         default_wallet.public_key AS default_wallet_public_key,
         c.last_check_status,
         pc.status AS credential_status,
         pc.storage_backend,
         pc.secret_ref,
         pc.secret_version_ref,
         pc.encrypted_secret_payload
       FROM custody_wallet_owners o
       CROSS JOIN connection_policy policy
       LEFT JOIN custody_scope_defaults project_default
         ON project_default.organization_id = o.organization_id
        AND project_default.project_id = ?
       LEFT JOIN custody_scope_defaults organization_default
         ON organization_default.organization_id = o.organization_id
        AND organization_default.project_id IS NULL
       LEFT JOIN custody_connections selected_connection
         ON selected_connection.id = project_default.default_custody_connection_id
        AND selected_connection.organization_id = project_default.organization_id
        AND selected_connection.project_id = project_default.project_id
       LEFT JOIN custody_connections c
         ON o.owner_kind = 'connection'
        AND c.id = o.owner_id
       LEFT JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       LEFT JOIN custody_wallets default_wallet
         ON default_wallet.id = c.default_custody_wallet_id
        AND default_wallet.custody_connection_id = c.id
        AND default_wallet.status = 'active'
       WHERE o.organization_id = ?
         AND ${ownerPredicate}
         AND o.status = 'active'
         AND (
           (o.owner_kind = 'config' AND (
             (?::text IS NOT NULL AND (o.project_id = ? OR o.project_id IS NULL))
             OR (?::text IS NULL AND o.project_id IS NULL)
           ))
           OR (
             o.owner_kind = 'connection'
             AND o.provider = ANY(policy.enabled_providers)
             AND ?::text IS NOT NULL
             AND o.project_id = ?
           )
       )
       ORDER BY
         ${preferredCustodyWalletId ? "CASE WHEN o.id = ? THEN 0 ELSE 1 END," : ""}
         is_selected DESC NULLS LAST,
         CASE WHEN o.project_id = ? THEN 0 ELSE 1 END,
         o.created_at DESC,
         o.id DESC
       LIMIT 1`,
      [
        this.enabledConnectionProviders,
        projectId ?? null,
        organizationId,
        ...ownerParams,
        projectId ?? null,
        projectId ?? null,
        projectId ?? null,
        projectId ?? null,
        projectId ?? null,
        ...(preferredCustodyWalletId ? [preferredCustodyWalletId] : []),
        projectId ?? null,
      ]
    );

    const row = rows[0];
    return row ? mapWalletOwner(row) : null;
  }

  async persistCreatedWallet(params: {
    organizationId: string;
    projectId: string;
    connectionId: string;
    providerCredentialId: string;
    walletId: string;
    publicKey: string;
    label?: string;
    purpose?: WalletPurpose;
    setDefault: boolean;
  }): Promise<{ wallet: ConnectionCustodyWallet; firstWallet: boolean }> {
    return this.db.transaction(async (tx) => {
      await lockProject(tx, params.organizationId, params.projectId);
      const connection = await findLockedConnection(
        tx,
        params.organizationId,
        params.projectId,
        params.connectionId,
        this.enabledConnectionProviders
      );
      if (
        !connection ||
        connection.provider_credential_id !== params.providerCredentialId ||
        connection.credential_status !== "active" ||
        connection.last_check_status !== "success" ||
        (connection.status !== "pending" && connection.status !== "active")
      ) {
        throw new SigningError("Custody Connection changed during wallet creation", "CONFLICT");
      }

      const firstWallet = connection.default_custody_wallet_id === null;
      if (
        (firstWallet && connection.status !== "pending") ||
        (!firstWallet && connection.status !== "active")
      ) {
        throw new SigningError("Custody Connection is not usable", "CONFLICT");
      }

      const walletId = `cwlt_${crypto.randomUUID()}`;
      const row = await tx.queryOne<WalletOwnerRow>(
        `INSERT INTO custody_wallets (
           id, custody_config_id, custody_connection_id, wallet_id, public_key,
           label, purpose, status, updated_at
         ) VALUES (?, NULL, ?, ?, ?, ?, ?, 'active', sdp_iso_now())
         RETURNING *, 'connection'::text AS owner_kind, ?::text AS owner_id,
                   ?::text AS organization_id, ?::text AS project_id,
                   'privy'::text AS provider, 'active'::text AS owner_status,
                   FALSE AS is_selected, NULL::text AS provider_credential_id,
                   NULL::text AS default_custody_wallet_id,
                   NULL::text AS default_wallet_id,
                   NULL::text AS default_wallet_public_key,
                   NULL::text AS last_check_status,
                   NULL::text AS credential_status,
                   NULL::text AS storage_backend, NULL::text AS secret_ref,
                   NULL::text AS secret_version_ref,
                   NULL::text AS encrypted_secret_payload`,
        [
          walletId,
          params.connectionId,
          params.walletId,
          params.publicKey,
          params.label ?? null,
          params.purpose ?? null,
          params.connectionId,
          params.organizationId,
          params.projectId,
        ]
      );
      if (!row) {
        throw new SigningError("Failed to persist wallet record", "INTERNAL_ERROR");
      }

      if (firstWallet || params.setDefault) {
        await tx.execute(
          `UPDATE custody_connections
           SET default_custody_wallet_id = ?,
               status = CASE WHEN ? THEN 'active' ELSE status END,
               activated_at = CASE WHEN ? THEN sdp_iso_now() ELSE activated_at END,
               updated_at = sdp_iso_now()
           WHERE id = ?`,
          [walletId, firstWallet, firstWallet, params.connectionId]
        );
      }

      if (firstWallet) {
        await selectConnectionInTransaction(
          tx,
          params.organizationId,
          params.projectId,
          params.connectionId
        );
      }

      return { wallet: mapWallet(row), firstWallet };
    });
  }

  async setDefaultWallet(
    organizationId: string,
    projectId: string,
    connectionId: string,
    custodyWalletId: string
  ): Promise<void> {
    const updated = await this.db.execute(
      `UPDATE custody_connections c
       SET default_custody_wallet_id = ?, updated_at = sdp_iso_now()
       WHERE c.id = ?
         AND c.organization_id = ?
         AND c.project_id = ?
         AND c.provider = ANY(?::text[])
         AND c.status = 'active'
         AND c.last_check_status = 'success'
         AND EXISTS (
           SELECT 1
           FROM provider_credentials pc
           WHERE pc.id = c.provider_credential_id
             AND pc.status = 'active'
         )
         AND EXISTS (
           SELECT 1
           FROM custody_wallets w
           WHERE w.id = ?
             AND w.custody_connection_id = c.id
             AND w.status = 'active'
         )`,
      [
        custodyWalletId,
        connectionId,
        organizationId,
        projectId,
        this.enabledConnectionProviders,
        custodyWalletId,
      ]
    );
    if (updated !== 1) {
      throw new SigningError("Custody wallet not found", "WALLET_NOT_FOUND");
    }
  }

  async selectConnection(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<ConnectionCustodyWallet> {
    return this.db.transaction(async (tx) => {
      await lockProject(tx, organizationId, projectId);
      const connection = await findLockedConnection(
        tx,
        organizationId,
        projectId,
        connectionId,
        this.enabledConnectionProviders
      );
      if (
        connection?.status !== "active" ||
        connection.last_check_status !== "success" ||
        connection.credential_status !== "active" ||
        !connection.default_custody_wallet_id
      ) {
        throw new SigningError("Custody Connection is not usable", "CONFLICT");
      }

      const wallet = await tx.queryOne<WalletOwnerRow>(
        `SELECT w.*, 'connection'::text AS owner_kind, ?::text AS owner_id,
                ?::text AS organization_id, ?::text AS project_id,
                'privy'::text AS provider, 'active'::text AS owner_status,
                TRUE AS is_selected, NULL::text AS provider_credential_id,
                NULL::text AS default_custody_wallet_id,
                NULL::text AS default_wallet_id,
                NULL::text AS default_wallet_public_key,
                NULL::text AS last_check_status,
                NULL::text AS credential_status,
                NULL::text AS storage_backend, NULL::text AS secret_ref,
                NULL::text AS secret_version_ref,
                NULL::text AS encrypted_secret_payload
         FROM custody_wallets w
         WHERE w.id = ?
           AND w.custody_connection_id = ?
           AND w.status = 'active'`,
        [
          connectionId,
          organizationId,
          projectId,
          connection.default_custody_wallet_id,
          connectionId,
        ]
      );
      if (!wallet) {
        throw new SigningError("Custody Connection default wallet is unavailable", "CONFLICT");
      }

      await selectConnectionInTransaction(tx, organizationId, projectId, connectionId);
      return mapWallet(wallet);
    });
  }

  async selectConfig(
    organizationId: string,
    projectId: string,
    configId: string,
    options: { clearConnection: boolean }
  ): Promise<{ walletId: string; publicKey: string }> {
    return this.db.transaction(async (tx) => {
      await lockProject(tx, organizationId, projectId);
      const config = await tx.queryOne<{
        id: string;
        provider: string;
        default_wallet_id: string | null;
      }>(
        `SELECT id, provider, default_wallet_id
         FROM custody_configs
         WHERE id = ?
           AND organization_id = ?
           AND status = 'active'
           AND (project_id = ? OR project_id IS NULL)
         LIMIT 1
         FOR UPDATE`,
        [configId, organizationId, projectId]
      );
      if (!config) {
        throw new SigningError("Custody configuration not found", "NOT_FOUND");
      }

      const blockSameProviderConnection =
        options.clearConnection &&
        this.enabledConnectionProviders.some((provider) => provider === config.provider);

      if (blockSameProviderConnection) {
        const connection = await tx.queryOne<{ id: string }>(
          `SELECT c.id
           FROM custody_connections c
           JOIN provider_credentials pc ON pc.id = c.provider_credential_id
           WHERE c.organization_id = ?
             AND c.project_id = ?
             AND c.provider = ?
           ORDER BY c.created_at, c.id
           LIMIT 1
           FOR UPDATE OF c, pc`,
          [organizationId, projectId, config.provider]
        );
        if (connection) {
          throw new SigningError("Custody Connection takes precedence", "CONFLICT");
        }
      }

      const wallet = await tx.queryOne<{ wallet_id: string; public_key: string }>(
        `SELECT wallet_id, public_key
         FROM custody_wallets
         WHERE custody_config_id = ?
           AND status = 'active'
         ORDER BY CASE WHEN wallet_id = ? THEN 0 ELSE 1 END, created_at
         LIMIT 1
         FOR UPDATE`,
        [configId, config.default_wallet_id ?? ""]
      );
      if (!wallet) {
        throw new SigningError("Active provider is missing an active wallet", "CONFLICT");
      }

      const existing = await tx.queryOne<{ id: string }>(
        `SELECT id
         FROM custody_scope_defaults
         WHERE organization_id = ? AND project_id = ?
         FOR UPDATE`,
        [organizationId, projectId]
      );
      if (existing) {
        await tx.execute(
          `UPDATE custody_scope_defaults
           SET default_custody_config_id = ?,
               default_custody_connection_id =
                 CASE
                   WHEN ? AND EXISTS (
                     SELECT 1
                     FROM custody_connections selected_connection
                     WHERE selected_connection.id =
                           custody_scope_defaults.default_custody_connection_id
                       AND selected_connection.provider = ANY(?::text[])
                   )
                     THEN NULL
                   ELSE default_custody_connection_id
                 END,
               updated_at = sdp_iso_now()
           WHERE id = ?`,
          [configId, options.clearConnection, this.enabledConnectionProviders, existing.id]
        );
        return { walletId: wallet.wallet_id, publicKey: wallet.public_key };
      }

      await tx.execute(
        `INSERT INTO custody_scope_defaults (
           id, organization_id, project_id,
           default_custody_config_id, default_custody_connection_id
         ) VALUES (?, ?, ?, ?, NULL)`,
        [`csd_${crypto.randomUUID()}`, organizationId, projectId, configId]
      );
      return { walletId: wallet.wallet_id, publicKey: wallet.public_key };
    });
  }
}

function connectionSelect(): string {
  return `SELECT
            c.id, c.organization_id, c.project_id, c.provider,
            c.provider_credential_id, c.default_custody_wallet_id,
            default_wallet.wallet_id AS default_wallet_id,
            default_wallet.public_key AS default_wallet_public_key,
            c.status, c.last_check_status,
            pc.status AS credential_status, pc.storage_backend,
            pc.secret_ref, pc.secret_version_ref, pc.encrypted_secret_payload
          FROM custody_connections c
          JOIN provider_credentials pc ON pc.id = c.provider_credential_id
          LEFT JOIN custody_wallets default_wallet
            ON default_wallet.id = c.default_custody_wallet_id
           AND default_wallet.custody_connection_id = c.id
           AND default_wallet.status = 'active'`;
}

async function findLockedConnection(
  tx: DatabaseExecutor,
  organizationId: string,
  projectId: string,
  connectionId: string,
  enabledConnectionProviders: readonly CustodyConnectionRuntimeRecord["provider"][]
): Promise<ConnectionRow | null> {
  return tx.queryOne<ConnectionRow>(
    `${connectionSelect()}
     WHERE c.id = ?
       AND c.organization_id = ?
       AND c.project_id = ?
       AND c.provider = ANY(?::text[])
     FOR UPDATE OF c, pc`,
    [connectionId, organizationId, projectId, enabledConnectionProviders]
  );
}

async function lockProject(
  tx: DatabaseExecutor,
  organizationId: string,
  projectId: string
): Promise<void> {
  const project = await tx.queryOne<{ id: string }>(
    `SELECT id
     FROM projects
     WHERE id = ? AND organization_id = ? AND status = 'active'
     FOR UPDATE`,
    [projectId, organizationId]
  );
  if (!project) {
    throw new SigningError("Project not found", "NOT_FOUND");
  }
}

async function selectConnectionInTransaction(
  tx: DatabaseExecutor,
  organizationId: string,
  projectId: string,
  connectionId: string
): Promise<void> {
  const existing = await tx.queryOne<{ id: string }>(
    `SELECT id
     FROM custody_scope_defaults
     WHERE organization_id = ? AND project_id = ?
     FOR UPDATE`,
    [organizationId, projectId]
  );
  if (existing) {
    await tx.execute(
      `UPDATE custody_scope_defaults
       SET default_custody_connection_id = ?, updated_at = sdp_iso_now()
       WHERE id = ?`,
      [connectionId, existing.id]
    );
    return;
  }

  await tx.execute(
    `INSERT INTO custody_scope_defaults (
       id, organization_id, project_id,
       default_custody_config_id, default_custody_connection_id
     ) VALUES (?, ?, ?, NULL, ?)`,
    [`csd_${crypto.randomUUID()}`, organizationId, projectId, connectionId]
  );
}

function mapConnection(row: ConnectionRow): CustodyConnectionRuntimeRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    provider: row.provider,
    providerCredentialId: row.provider_credential_id,
    defaultCustodyWalletId: row.default_custody_wallet_id,
    defaultWalletId: row.default_wallet_id,
    defaultWalletPublicKey: row.default_wallet_public_key,
    status: row.status,
    lastCheckStatus: row.last_check_status,
    credentialStatus: row.credential_status,
    credentialStorageBackend: row.storage_backend,
    credentialSecretRef: row.secret_ref,
    credentialSecretVersionRef: row.secret_version_ref,
    credentialEncryptedSecretPayload: row.encrypted_secret_payload,
  };
}

function mapWallet(row: WalletOwnerRow): ConnectionCustodyWallet {
  return {
    id: row.id,
    walletId: row.wallet_id,
    publicKey: row.public_key,
    label: row.label,
    purpose: row.purpose as WalletPurpose | null,
    status: row.status as "active" | "inactive",
    createdAt: row.created_at,
  };
}

function mapWalletOwner(row: WalletOwnerRow): CustodyWalletOwner {
  const base = {
    ownerId: row.owner_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    provider: row.provider,
    ownerStatus: row.owner_status,
    isSelected: row.is_selected,
    wallet: mapWallet(row),
  };
  if (row.owner_kind === "config") {
    if (!row.custody_config_id) {
      throw new Error("Config-owned wallet is missing custody_config_id");
    }
    return {
      ...base,
      kind: "config",
      custodyConfigId: row.custody_config_id,
    };
  }

  if (
    !row.custody_connection_id ||
    !row.project_id ||
    !row.provider_credential_id ||
    !row.credential_status ||
    !row.storage_backend
  ) {
    throw new Error("Connection-owned wallet is missing owner metadata");
  }

  return {
    ...base,
    kind: "connection",
    provider: "privy",
    projectId: row.project_id,
    connection: mapConnection({
      id: row.custody_connection_id,
      organization_id: row.organization_id,
      project_id: row.project_id,
      provider: "privy",
      provider_credential_id: row.provider_credential_id,
      default_custody_wallet_id: row.default_custody_wallet_id,
      default_wallet_id: row.default_wallet_id,
      default_wallet_public_key: row.default_wallet_public_key,
      status: row.owner_status as CustodyConnectionRuntimeStatus,
      last_check_status: row.last_check_status,
      credential_status: row.credential_status,
      storage_backend: row.storage_backend,
      secret_ref: row.secret_ref,
      secret_version_ref: row.secret_version_ref,
      encrypted_secret_payload: row.encrypted_secret_payload,
    }),
  };
}
