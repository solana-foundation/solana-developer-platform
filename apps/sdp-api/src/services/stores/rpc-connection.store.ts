import type { RpcConnectionLifecycle, RpcConnectionNetwork, RpcConnectionScope } from "@sdp/types";
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
   * The connection this scope holds for one provider, if it still has one.
   *
   * Excludes `deactivated` rows because those are terminal: the secret is
   * destroyed, so promoting one would report success and route nothing. Used to
   * answer "does switching to this provider mean using their own key or ours".
   */
  async findLiveConnectionForProvider(params: {
    organizationId: string;
    scopeKey: string;
    network: RpcConnectionNetwork;
    provider: string;
    executor?: DatabaseExecutor;
  }): Promise<{ id: string; is_default: boolean } | null> {
    const db = params.executor ?? this.db;
    return db.queryOne<{ id: string; is_default: boolean }>(
      `SELECT id, is_default
         FROM rpc_connections
        WHERE organization_id = ?
          AND scope_key = ?
          AND network = ?
          AND provider = ?
          AND status <> 'deactivated'
        ORDER BY is_default DESC, created_at DESC
        LIMIT 1`,
      [params.organizationId, params.scopeKey, params.network, params.provider]
    );
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
   * Point a connection at a freshly stored credential and retire the old one
   * (HOO-1229).
   *
   * Both halves are one statement pair inside the caller's transaction: a
   * connection pointing at a retired credential resolves to nothing, so a
   * crash between them would take the project off its own key without anyone
   * asking for that.
   */
  async repointConnectionCredential(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
    /**
     * The credential the caller read before it built the replacement. Matching
     * on it makes this a compare-and-swap: two rotations racing each other both
     * see the same previous credential, and without this both would commit. The
     * last write would win while the other replacement stayed active with its
     * secret stored, and the losing request would return a credential id the
     * connection no longer used.
     */
    expectedCredentialId: string;
    nextCredentialId: string;
    nextCredentialScopeKey: string;
    executor?: DatabaseExecutor;
  }): Promise<RpcConnectionRow | null> {
    const db = params.executor ?? this.db;
    return db.queryOne<RpcConnectionRow>(
      `UPDATE rpc_connections
          SET provider_credential_id = ?,
              provider_credential_scope_key = ?,
              status = 'active',
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?
          AND scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})
          AND status <> 'deactivated'
          AND provider_credential_id = ?
        RETURNING ${CONNECTION_COLUMNS}`,
      [
        params.nextCredentialId,
        params.nextCredentialScopeKey,
        params.connectionId,
        params.organizationId,
        ...params.scopeKeys,
        params.expectedCredentialId,
      ]
    );
  }

  /**
   * Promote a freshly inserted credential straight to active. Rotation has
   * already probed the key, so the `pending` state the insert starts in would
   * only be a window where the connection resolves to nothing.
   */
  async activateCredentialById(params: {
    organizationId: string;
    providerCredentialId: string;
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    return db.execute(
      `UPDATE provider_credentials
          SET status = 'active',
              last_validated_at = sdp_iso_now(),
              last_failure_code = NULL,
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?
          AND status = 'pending'`,
      [params.providerCredentialId, params.organizationId]
    );
  }

  /** Retire a credential a rotation has replaced. */
  async retireCredential(params: {
    organizationId: string;
    providerCredentialId: string;
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    return db.execute(
      `UPDATE provider_credentials
          SET status = 'retired',
              encrypted_secret_payload = NULL,
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?`,
      [params.providerCredentialId, params.organizationId]
    );
  }

  /**
   * Live connections anywhere in the organization, across every project and
   * network. Used to refuse a fail-closed switch that would have nothing to
   * fall closed onto.
   */
  async countLiveConnectionsForOrganization(params: {
    organizationId: string;
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    const row = await db.queryOne<{ live: number }>(
      `SELECT COUNT(*)::int AS live
         FROM rpc_connections c
         JOIN provider_credentials pc ON pc.id = c.provider_credential_id
        WHERE c.organization_id = ?
          AND c.status = 'active'
          AND pc.status = 'active'`,
      [params.organizationId]
    );
    return row?.live ?? 0;
  }

  /**
   * How many connections a scope still has that are not withdrawn (HOO-1227).
   *
   * Deactivated rows are excluded because they are terminal: they hold no
   * secret and route nothing, so counting them would block a project that has
   * only ever had connections it already gave up.
   */
  async countLiveConnections(params: {
    organizationId: string;
    scopeKey: string;
    network: RpcConnectionNetwork;
    /**
     * Narrow to one provider. A scope may hold a connection per provider now,
     * so "does this project already have one" and "does this project already
     * have an Alchemy one" are different questions and only the second blocks
     * a save.
     */
    provider?: string;
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    // Built rather than parameterised against NULL: an untyped placeholder
    // compared to NULL leaves Postgres unable to infer the parameter type.
    const providerClause = params.provider ? " AND provider = ?" : "";
    const values: unknown[] = [params.organizationId, params.scopeKey, params.network];
    if (params.provider) {
      values.push(params.provider);
    }
    const row = await db.queryOne<{ live: number }>(
      `SELECT COUNT(*)::int AS live
         FROM rpc_connections
        WHERE organization_id = ?
          AND scope_key = ?
          AND network = ?
          AND status <> 'deactivated'${providerClause}`,
      values
    );
    return row?.live ?? 0;
  }

  /**
   * Remove a deactivated connection and the credential it hung off (HOO-1219).
   *
   * Only `deactivated` rows match. Deactivation is what destroys the secret, so
   * by the time a row is deletable there is nothing left to leak, and the
   * credential row is a record of a key that no longer exists anywhere. The
   * guard is in the WHERE clause rather than a prior read so a concurrent
   * activation cannot slip between the check and the delete.
   */
  async deleteDeactivatedConnection(params: {
    organizationId: string;
    connectionId: string;
    scopeKeys: readonly string[];
    executor?: DatabaseExecutor;
  }): Promise<{ id: string; provider_credential_id: string } | null> {
    const db = params.executor ?? this.db;
    return db.queryOne<{ id: string; provider_credential_id: string }>(
      `DELETE FROM rpc_connections
        WHERE id = ?
          AND organization_id = ?
          AND scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})
          AND status = 'deactivated'
        RETURNING id, provider_credential_id`,
      [params.connectionId, params.organizationId, ...params.scopeKeys]
    );
  }

  /**
   * Drop the credential a deleted connection pointed at, as long as nothing
   * else still references it. A credential is per-connection today, but the
   * rotation column is a self-reference, so checking is cheaper than assuming.
   */
  async deleteOrphanedCredential(params: {
    organizationId: string;
    providerCredentialId: string;
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    return db.execute(
      `DELETE FROM provider_credentials
        WHERE id = ?
          AND organization_id = ?
          AND status = 'deactivated'
          AND NOT EXISTS (
                SELECT 1 FROM rpc_connections c WHERE c.provider_credential_id = provider_credentials.id
              )`,
      [params.providerCredentialId, params.organizationId]
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

  /**
   * Mark a connection as failing its check.
   *
   * The check *result* is no longer stored (HOO-1228), but the lifecycle flip
   * is not a result -- it is what makes the relay fail closed instead of
   * quietly answering on platform keys. The redacted code is reported to the
   * caller and deliberately not written down.
   */
  /**
   * Record that a probe rejected this connection.
   *
   * Matched on the credential the probe actually tested, not on the connection
   * alone. A probe is a network call, so a rotation can land while one is in
   * flight: the connection then points at a new, proven key, and writing the
   * old verdict onto it would mark a working connection failed and clear it out
   * of the default slot, failing the project closed over a key that no longer
   * exists. The compare-and-swap makes the stale write miss instead.
   *
   * Returns the rows changed so a caller can tell a real failure from a verdict
   * that arrived too late to mean anything.
   */
  async markCheckFailed(params: {
    organizationId: string;
    connectionId: string;
    providerCredentialId: string;
    scopeKeys: readonly string[];
    executor?: DatabaseExecutor;
  }): Promise<number> {
    const db = params.executor ?? this.db;
    return db.execute(
      `UPDATE rpc_connections
          SET status = 'failed',
              is_default = FALSE,
              updated_at = sdp_iso_now()
        WHERE id = ?
          AND organization_id = ?
          AND provider_credential_id = ?
          AND scope_key IN (${params.scopeKeys.map(() => "?").join(", ")})`,
      [params.connectionId, params.organizationId, params.providerCredentialId, ...params.scopeKeys]
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
    credential_version: number;
    storage_backend: string;
    secret_ref: string | null;
    secret_version_ref: string | null;
    encrypted_secret_payload: string | null;
  } | null> {
    return this.db.queryOne(
      `SELECT pc.id,
              pc.label,
              pc.status,
              pc.credential_version,
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
    if (live) {
      return { kind: "active", connectionId: live.id };
    }

    /**
     * Only a connection that was *meant* to serve and cannot may fail requests
     * closed. Holding keys that are deliberately idle is an ordinary state now:
     * a project keeps a key per provider, and choosing a provider it holds none
     * for stands them all down so SDP's account answers.
     *
     * The absence of a default used to be the test, which conflated the two.
     * `markCheckFailed` also clears `is_default`, so a broken connection and a
     * stood-down one are indistinguishable by that flag: every deliberate
     * switch onto a platform provider read as a fault and the relay refused
     * every call with "no active default connection".
     *
     * A failed row still fails closed even though nothing points at it. The
     * tenant last saw it serving, and quietly moving their traffic onto keys
     * SDP pays for is the outcome this whole feature exists to prevent.
     */
    const broken = rows.some(
      (row) => row.status !== "active" || (row.is_default && row.credential_status !== "active")
    );
    return broken ? { kind: "unusable" } : { kind: "none" };
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
