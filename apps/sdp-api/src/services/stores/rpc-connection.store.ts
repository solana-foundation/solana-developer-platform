import type {
  RpcConnectionCheckStatus,
  RpcConnectionLifecycle,
  RpcConnectionNetwork,
  RpcConnectionScope,
} from "@sdp/types";
import type { DatabaseExecutor } from "@/db";

/** The organization-scope sentinel `scope_key` is generated as. */
export const ORGANIZATION_SCOPE_KEY = "__organization__";

export interface RpcConnectionRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  provider: string;
  scope: RpcConnectionScope;
  scope_key: string;
  provider_credential_id: string;
  provider_credential_scope_key: string;
  network: RpcConnectionNetwork;
  status: RpcConnectionLifecycle;
  is_default: boolean;
  display_metadata: unknown;
  last_check_status: RpcConnectionCheckStatus | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  created_at: string;
}

export interface RpcConnectionListRow extends RpcConnectionRow {
  credential_id: string;
  credential_label: string;
  credential_status: string;
}

const CONNECTION_COLUMN_NAMES = [
  "id",
  "organization_id",
  "project_id",
  "provider",
  "scope",
  "scope_key",
  "provider_credential_id",
  "provider_credential_scope_key",
  "network",
  "status",
  "is_default",
  "display_metadata",
  "last_check_status",
  "last_check_at",
  "last_check_failure_code",
  "activated_at",
  "deactivated_at",
  "created_at",
] as const;

const CONNECTION_COLUMNS = CONNECTION_COLUMN_NAMES.join(", ");
/** Same list, qualified for the statements that join provider_credentials. */
const JOINED_CONNECTION_COLUMNS = CONNECTION_COLUMN_NAMES.map((column) => `c.${column}`).join(", ");

export function toScopeKey(projectId: string | null): string {
  return projectId ?? ORGANIZATION_SCOPE_KEY;
}

export class RpcConnectionStore {
  constructor(private readonly db: DatabaseExecutor) {}

  /**
   * Everything visible in one scope. Organization scope is listed on its own
   * rather than unioned with every project: a project admin reading their own
   * connections must not enumerate another project's.
   */
  async listConnectionsPage(
    organizationId: string,
    scopeKey: string,
    options: { limit: number; offset: number }
  ): Promise<{ connections: RpcConnectionListRow[]; total: number }> {
    const totalRow = await this.db.queryOne<{ total: number | string }>(
      `SELECT COUNT(*) AS total
         FROM rpc_connections
        WHERE organization_id = ? AND scope_key = ?`,
      [organizationId, scopeKey]
    );

    const connections = await this.db.queryMany<RpcConnectionListRow>(
      `SELECT ${JOINED_CONNECTION_COLUMNS},
              pc.id AS credential_id,
              pc.label AS credential_label,
              pc.status AS credential_status
         FROM rpc_connections c
         JOIN provider_credentials pc ON pc.id = c.provider_credential_id
        WHERE c.organization_id = ? AND c.scope_key = ?
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ? OFFSET ?`,
      [organizationId, scopeKey, options.limit, options.offset]
    );

    return { connections, total: Number(totalRow?.total ?? 0) };
  }

  /**
   * Organization- and scope-qualified: an id alone must never resolve a row.
   *
   * `scopeKeys` is the set the caller is acting within -- the organization
   * sentinel plus the selected project, never another project's. Without it an
   * administrator working in one project could name a connection belonging to
   * another and read or mutate it.
   */
  async findConnection(
    organizationId: string,
    connectionId: string,
    scopeKeys: readonly string[]
  ): Promise<RpcConnectionRow | null> {
    return this.db.queryOne<RpcConnectionRow>(
      `SELECT ${CONNECTION_COLUMNS}
         FROM rpc_connections
        WHERE id = ?
          AND organization_id = ?
          AND scope_key IN (${scopeKeys.map(() => "?").join(", ")})`,
      [connectionId, organizationId, ...scopeKeys]
    );
  }

  async insertConnection(params: {
    id: string;
    organizationId: string;
    projectId: string | null;
    provider: string;
    providerCredentialId: string;
    providerCredentialScopeKey: string;
    network: RpcConnectionNetwork;
    displayMetadata: Record<string, unknown>;
    createdBy: string | null;
    executor?: DatabaseExecutor;
  }): Promise<RpcConnectionRow> {
    const db = params.executor ?? this.db;
    const row = await db.queryOne<RpcConnectionRow>(
      `INSERT INTO rpc_connections (
         id, organization_id, project_id, provider, scope,
         provider_credential_id, provider_credential_scope_key,
         network, display_metadata, status, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       RETURNING ${CONNECTION_COLUMNS}`,
      [
        params.id,
        params.organizationId,
        params.projectId,
        params.provider,
        params.projectId ? "project" : "organization",
        params.providerCredentialId,
        params.providerCredentialScopeKey,
        params.network,
        JSON.stringify(params.displayMetadata),
        params.createdBy,
      ]
    );
    if (!row) {
      throw new Error("RPC connection insert returned no row");
    }
    return row;
  }

  /**
   * Demote whatever currently holds the default slot for this scope and
   * network. Runs inside the activation transaction so the partial unique
   * index never sees two winners.
   */
  async clearDefault(params: {
    organizationId: string;
    scopeKey: string;
    network: RpcConnectionNetwork;
    exceptConnectionId?: string;
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    return db.execute(
      `UPDATE rpc_connections
          SET is_default = FALSE, updated_at = sdp_iso_now()
        WHERE organization_id = ?
          AND scope_key = ?
          AND network = ?
          AND is_default = TRUE
          AND id <> ?`,
      [params.organizationId, params.scopeKey, params.network, params.exceptConnectionId ?? ""]
    );
  }

  async activateConnection(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
    makeDefault: boolean;
    executor?: DatabaseExecutor;
  }): Promise<RpcConnectionRow | null> {
    const db = params.executor ?? this.db;
    return db.queryOne<RpcConnectionRow>(
      `UPDATE rpc_connections
          SET status = 'active',
              activated_at = COALESCE(activated_at, sdp_iso_now()),
              deactivated_at = NULL,
              is_default = ?,
              last_check_status = 'success',
              last_check_at = sdp_iso_now(),
              last_check_failure_code = NULL,
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?
          AND scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})
          AND status IN ('pending', 'checking', 'failed', 'active')
        RETURNING ${CONNECTION_COLUMNS}`,
      [params.makeDefault, params.connectionId, params.organizationId, ...params.scopeKeys]
    );
  }

  /**
   * Promote the credential the connection points at, in the same transaction
   * that activates the connection.
   *
   * `insertCredential` writes `pending`, and a successful activation probe is
   * the only evidence the key works. Without this the credential stays pending
   * forever while the connection reads active, `findEffectiveConnection` never
   * matches, and the organization's traffic keeps leaving on SDP's keys — the
   * exact silent fallback this whole path exists to prevent.
   *
   * Reached through the connection rather than by id so the organization and
   * scope checks are the same ones the caller already passed. `deactivated`
   * and `retired` are excluded: neither may be resurrected by an activation.
   */
  async activateConnectionCredential(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    return db.execute(
      `UPDATE provider_credentials
          SET status = 'active',
              last_validated_at = sdp_iso_now(),
              last_failure_code = NULL,
              updated_at = sdp_iso_now()
        WHERE id = (
                SELECT c.provider_credential_id
                  FROM rpc_connections c
                 WHERE c.id = ?
                   AND c.organization_id = ?
                   AND c.scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})
              )
          AND status IN ('pending', 'failed_validation', 'active')`,
      [params.connectionId, params.organizationId, ...params.scopeKeys]
    );
  }

  /**
   * Deactivation drops the default flag in the same statement. Leaving it set
   * would keep a dead connection occupying the slot the relay reads.
   */
  async deactivateConnection(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
    executor?: DatabaseExecutor;
  }): Promise<RpcConnectionRow | null> {
    const db = params.executor ?? this.db;
    return db.queryOne<RpcConnectionRow>(
      `UPDATE rpc_connections
          SET status = 'deactivated',
              is_default = FALSE,
              deactivated_at = sdp_iso_now(),
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?
          AND scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})
          AND status <> 'deactivated'
        RETURNING ${CONNECTION_COLUMNS}`,
      [params.connectionId, params.organizationId, ...params.scopeKeys]
    );
  }

  /**
   * Withdraw the credential together with its connection. The `encrypted_db`
   * ciphertext is dropped in the same statement: on self-hosted deployments it
   * is the secret itself, and a deactivated credential must not keep a
   * decryptable copy of a key the customer withdrew. Secret Manager versions
   * are destroyed separately by the service, best effort.
   */
  async deactivateConnectionCredential(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    return db.execute(
      `UPDATE provider_credentials
          SET status = 'deactivated',
              encrypted_secret_payload = NULL,
              deactivated_at = sdp_iso_now(),
              updated_at = sdp_iso_now()
        WHERE id = (
                SELECT c.provider_credential_id
                  FROM rpc_connections c
                 WHERE c.id = ?
                   AND c.organization_id = ?
                   AND c.scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})
              )
          AND status <> 'deactivated'`,
      [params.connectionId, params.organizationId, ...params.scopeKeys]
    );
  }

  async recordCheckFailure(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
    failureCode: string;
    executor?: DatabaseExecutor;
  }): Promise<void> {
    const db = params.executor ?? this.db;
    await db.execute(
      `UPDATE rpc_connections
          SET status = 'failed',
              is_default = FALSE,
              last_check_status = 'failed',
              last_check_at = sdp_iso_now(),
              last_check_failure_code = ?,
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?
          AND scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})`,
      [params.failureCode, params.connectionId, params.organizationId, ...params.scopeKeys]
    );
  }

  /**
   * The credential secret columns for one connection, organization- and
   * scope-qualified. `ProviderCredentialStore.findCredential` deliberately
   * omits these and does not filter by organization, so activation reads them
   * through here instead.
   */
  async findConnectionSecret(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
  }): Promise<{
    id: string;
    label: string;
    status: string;
    storage_backend: string;
    secret_ref: string | null;
    secret_version_ref: string | null;
    encrypted_secret_payload: string | null;
  } | null> {
    return this.db.queryOne(
      `SELECT pc.id,
              pc.label,
              pc.status,
              pc.storage_backend,
              pc.secret_ref,
              pc.secret_version_ref,
              pc.encrypted_secret_payload
         FROM rpc_connections c
         JOIN provider_credentials pc ON pc.id = c.provider_credential_id
        WHERE c.id = ?
          AND c.organization_id = ?
          AND c.scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})`,
      [params.connectionId, params.organizationId, ...params.scopeKeys]
    );
  }

  /**
   * What the relay asks before falling back (HOO-1093).
   *
   * Returns the live default when there is one, and otherwise reports whether
   * the scope holds a connection at all. The epic requires an explicit but
   * unusable connection to fail closed rather than quietly spend SDP's own
   * credentials, so "nothing configured" and "configured but broken" cannot be
   * the same answer.
   *
   * Two things this deliberately does not treat as broken:
   *
   * `pending` and `checking` are drafts. Submitting a connection is not the
   * statement of intent — activating it is. An administrator who opens the form
   * and never finishes, or whose first probe is still running, must not take
   * every RPC call in the organization down; that row has never carried
   * traffic, so falling back to the platform rail changes nothing for them.
   *
   * `failed` is different and does fail closed: that connection was live, the
   * organization's traffic was on it, and moving that traffic back onto SDP's
   * keys without saying so is the thing being prevented. Re-activating clears
   * it once the key is fixed.
   *
   * The credential predicate matches `findEffectiveConnection` exactly. When
   * the two disagreed, this one could call a scope live that the effective
   * lookup would not resolve, and every disagreement resolved toward SDP paying.
   */
  async findScopeConnectionState(params: {
    organizationId: string;
    scopeKey: string;
    network: RpcConnectionNetwork;
  }): Promise<{ kind: "none" } | { kind: "unusable" } | { kind: "active"; connectionId: string }> {
    const rows = await this.db.queryMany<{
      id: string;
      status: string;
      is_default: boolean;
      credential_status: string;
    }>(
      `SELECT c.id, c.status, c.is_default, pc.status AS credential_status
         FROM rpc_connections c
         JOIN provider_credentials pc ON pc.id = c.provider_credential_id
        WHERE c.organization_id = ?
          AND c.scope_key = ?
          AND c.network = ?
          AND c.status NOT IN ('deactivated', 'pending', 'checking')`,
      [params.organizationId, params.scopeKey, params.network]
    );

    if (rows.length === 0) {
      return { kind: "none" };
    }

    const live = rows.find(
      (row) => row.status === "active" && row.is_default && row.credential_status === "active"
    );
    return live ? { kind: "active", connectionId: live.id } : { kind: "unusable" };
  }

  /**
   * What the relay reads (HOO-1093): the one active default for a scope and
   * network. Returns the credential's stored-secret columns so the caller can
   * hand them to CredentialSecretStore — this is the only method that carries
   * secret *references*, and it is never mapped into a response.
   */
  async findEffectiveConnection(params: {
    organizationId: string;
    scopeKey: string;
    network: RpcConnectionNetwork;
  }): Promise<{
    connection: RpcConnectionRow;
    credential: {
      id: string;
      storage_backend: string;
      secret_ref: string | null;
      secret_version_ref: string | null;
      encrypted_secret_payload: string | null;
    };
  } | null> {
    const row = await this.db.queryOne<
      RpcConnectionRow & {
        credential_id: string;
        storage_backend: string;
        secret_ref: string | null;
        secret_version_ref: string | null;
        encrypted_secret_payload: string | null;
      }
    >(
      `SELECT ${JOINED_CONNECTION_COLUMNS},
              pc.id AS credential_id,
              pc.storage_backend,
              pc.secret_ref,
              pc.secret_version_ref,
              pc.encrypted_secret_payload
         FROM rpc_connections c
         JOIN provider_credentials pc ON pc.id = c.provider_credential_id
        WHERE c.organization_id = ?
          AND c.scope_key = ?
          AND c.network = ?
          AND c.status = 'active'
          AND c.is_default = TRUE
          AND pc.status = 'active'
        LIMIT 1`,
      [params.organizationId, params.scopeKey, params.network]
    );

    if (!row) {
      return null;
    }

    return {
      connection: row,
      credential: {
        id: row.credential_id,
        storage_backend: row.storage_backend,
        secret_ref: row.secret_ref,
        secret_version_ref: row.secret_version_ref,
        encrypted_secret_payload: row.encrypted_secret_payload,
      },
    };
  }
}
