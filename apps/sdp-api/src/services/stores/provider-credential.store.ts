import type { CustodyConnectionCheckStatus, CustodyWalletStatus } from "@sdp/types";
import type { DatabaseExecutor } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";

export type ProviderCredentialStatus =
  | "creating"
  | "pending"
  | "active"
  | "failed_validation"
  | "retired"
  | "deactivated";

export type CustodyConnectionStatus = "pending" | "checking" | "active" | "failed" | "deactivated";

export interface ProviderCredentialRow {
  id: string;
  organization_id: string;
  project_id: string | null;
  /** Widened from the privy-only literal: RPC connections store credentials here too. */
  provider: string;
  label: string;
  scope: "organization" | "project";
  scope_key: string;
  display_metadata: unknown;
  status: ProviderCredentialStatus;
  credential_version: number;
  rotated_from_provider_credential_id: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  last_failure_code: string | null;
  created_at: string;
}

export interface LifecycleCredentialRow extends ProviderCredentialRow {
  source: "stored" | "runtime";
  storage_backend: StoredCredentialSecret["storageBackend"];
  deactivated_at: string | null;
  last_validated_at: string | null;
  last_failed_at: string | null;
  secret_retention_expires_at: string | null;
}

export interface LifecycleCredentialWithSecretRow extends LifecycleCredentialRow {
  secret_ref: string | null;
  secret_version_ref: string | null;
  encrypted_secret_payload: string | null;
}

export interface CredentialReferenceRow {
  id: string;
  project_id: string;
  project_name: string;
  status: CustodyConnectionStatus;
  provider_account_fingerprint: string | null;
}

export interface CustodyConnectionRow {
  id: string;
  organization_id: string;
  project_id: string;
  provider: "privy";
  scope: "project";
  provider_credential_id: string;
  provider_credential_scope_key: string;
  default_custody_wallet_id: string | null;
  provider_account_fingerprint: string | null;
  request_delay_ms: number | null;
  status: CustodyConnectionStatus;
  setup_metadata: unknown;
  last_check_status: CustodyConnectionCheckStatus | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  created_at: string;
}

export interface ProjectConnectionListRow {
  id: string;
  provider: "privy";
  connection_status: CustodyConnectionStatus;
  setup_metadata: unknown;
  last_check_status: CustodyConnectionCheckStatus | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
  activated_at: string | null;
  created_at: string;
  credential_label: string;
  credential_status: ProviderCredentialStatus;
  provider_account_fingerprint: string | null;
  default_custody_wallet_id: string | null;
  default_wallet_id: string | null;
  default_wallet_public_key: string | null;
  default_wallet_status: CustodyWalletStatus | null;
  is_selected: boolean;
}

export interface ProjectConnectionState extends CustodyConnectionRow {
  credential_status: ProviderCredentialStatus;
  credential_version: number;
  credential_scope: "organization" | "project";
}

export interface InstallationConnectionState extends CustodyConnectionRow {
  credential_label: string;
  credential_status: ProviderCredentialStatus;
  credential_version: number;
  credential_scope: "organization" | "project";
  credential_project_id: string | null;
  credential_source: "stored" | "runtime";
  credential_storage_backend: StoredCredentialSecret["storageBackend"];
  credential_secret_ref: string | null;
  credential_secret_version_ref: string | null;
  credential_encrypted_secret_payload: string | null;
  credential_display_metadata: unknown;
  credential_created_at: string;
  has_owned_wallet: boolean;
  has_sibling_unfinished: boolean;
  is_selected: boolean;
}

const CREATING_SUBMISSION = `creating.status = 'creating'
  AND (creating.rotated_from_provider_credential_id IS NULL OR EXISTS (
    SELECT 1 FROM provider_credentials predecessor
    WHERE predecessor.id = creating.rotated_from_provider_credential_id
      AND predecessor.status = 'failed_validation'
  ))`;

const CREDENTIAL_LINEAGE_SQL = `WITH RECURSIVE credential_lineage(id, rotated_from_provider_credential_id, credential_version) AS (
  SELECT id, rotated_from_provider_credential_id, credential_version
  FROM provider_credentials
  WHERE id = ? AND organization_id = ? AND provider = 'privy'
  UNION
  SELECT related.id, related.rotated_from_provider_credential_id, related.credential_version
  FROM provider_credentials related
  JOIN credential_lineage member
    ON related.rotated_from_provider_credential_id = member.id
    OR related.id = member.rotated_from_provider_credential_id
  WHERE related.organization_id = ? AND related.provider = 'privy'
)`;

export class ProviderCredentialStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async getDatabaseNowMs(): Promise<number> {
    const row = await this.db.queryOne<{ now_ms: number }>(
      `SELECT FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint AS now_ms`
    );
    if (!row) {
      throw new Error("Database clock query returned no row");
    }
    return row.now_ms;
  }

  async findReplayByKey(
    organizationId: string,
    idempotencyKey: string
  ): Promise<ProviderCredentialRow | null> {
    return this.db.queryOne<ProviderCredentialRow>(
      `SELECT id, organization_id, project_id, provider, label, scope, scope_key,
              display_metadata, status, credential_version,
              rotated_from_provider_credential_id, idempotency_key,
              idempotency_fingerprint, last_failure_code, created_at
       FROM provider_credentials
       WHERE organization_id = ? AND idempotency_key = ?`,
      [organizationId, idempotencyKey]
    );
  }

  async lockProject(organizationId: string, projectId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT id
       FROM projects
       WHERE id = ? AND organization_id = ? AND status = 'active'
       FOR UPDATE`,
      [projectId, organizationId]
    );
    return row !== null;
  }

  async listProjectConnections(
    organizationId: string,
    projectId: string,
    options: { lock?: boolean } = {}
  ): Promise<ProjectConnectionState[]> {
    return this.db.queryMany<ProjectConnectionState>(
      `SELECT c.id, c.organization_id, c.project_id, c.provider, c.scope,
              c.provider_credential_id, c.provider_credential_scope_key,
              c.default_custody_wallet_id, c.provider_account_fingerprint,
              c.request_delay_ms,
              c.status, c.setup_metadata,
              c.last_check_status, c.last_check_at, c.last_check_failure_code,
              c.activated_at, c.deactivated_at, c.created_at,
              pc.status AS credential_status,
              pc.credential_version AS credential_version,
              pc.scope AS credential_scope
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.provider = 'privy'
       ORDER BY c.created_at, c.id
       ${options.lock ? "FOR UPDATE OF c" : ""}`,
      [organizationId, projectId]
    );
  }

  async findCredential(
    id: string,
    options: { lock?: boolean } = {}
  ): Promise<ProviderCredentialRow | null> {
    return this.db.queryOne<ProviderCredentialRow>(
      `SELECT id, organization_id, project_id, provider, label, scope, scope_key,
              display_metadata, status, credential_version,
              rotated_from_provider_credential_id, idempotency_key,
              idempotency_fingerprint, last_failure_code, created_at
       FROM provider_credentials
       WHERE id = ?
       ${options.lock ? "FOR UPDATE" : ""}`,
      [id]
    );
  }

  async findLifecycleCredential(
    organizationId: string,
    id: string,
    options: { lock?: boolean } = {}
  ): Promise<LifecycleCredentialRow | null> {
    return this.db.queryOne<LifecycleCredentialRow>(
      `SELECT id, organization_id, project_id, provider, label, scope, scope_key,
              source, storage_backend, display_metadata, status, credential_version,
              rotated_from_provider_credential_id, idempotency_key,
              idempotency_fingerprint, deactivated_at, last_validated_at,
              last_failed_at, last_failure_code, secret_retention_expires_at, created_at
       FROM provider_credentials
       WHERE id = ? AND organization_id = ? AND provider = 'privy'
       ${options.lock ? "FOR UPDATE" : ""}`,
      [id, organizationId]
    );
  }

  async findLifecycleCredentialWithSecret(
    organizationId: string,
    id: string
  ): Promise<LifecycleCredentialWithSecretRow | null> {
    return this.db.queryOne<LifecycleCredentialWithSecretRow>(
      `SELECT id, organization_id, project_id, provider, label, scope, scope_key,
              source, storage_backend, secret_ref, secret_version_ref,
              encrypted_secret_payload, display_metadata, status, credential_version,
              rotated_from_provider_credential_id, idempotency_key,
              idempotency_fingerprint, deactivated_at, last_validated_at,
              last_failed_at, last_failure_code, secret_retention_expires_at, created_at
       FROM provider_credentials
       WHERE id = ? AND organization_id = ? AND provider = 'privy'`,
      [id, organizationId]
    );
  }

  async findGcpContainerRef(organizationId: string, credentialId: string): Promise<string | null> {
    const row = await this.db.queryOne<{ secret_ref: string }>(
      `SELECT secret_ref FROM provider_credentials
       WHERE id = ? AND organization_id = ? AND provider = 'privy'
         AND source = 'stored' AND storage_backend = 'gcp_secret_manager'
         AND secret_ref IS NOT NULL AND secret_version_ref IS NOT NULL`,
      [credentialId, organizationId]
    );
    return row?.secret_ref ?? null;
  }

  async findLifecycleConnectionCredentialId(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<string | null> {
    const row = await this.db.queryOne<{ provider_credential_id: string }>(
      `SELECT provider_credential_id
       FROM custody_connections
       WHERE id = ? AND organization_id = ? AND project_id = ? AND provider = 'privy'`,
      [connectionId, organizationId, projectId]
    );
    return row?.provider_credential_id ?? null;
  }

  async listCredentialReferences(
    organizationId: string,
    providerCredentialId: string,
    options: { lock?: boolean } = {}
  ): Promise<CredentialReferenceRow[]> {
    return this.db.queryMany<CredentialReferenceRow>(
      `SELECT c.id, c.project_id, p.name AS project_name, c.status,
              c.provider_account_fingerprint
       FROM custody_connections c
       JOIN projects p ON p.id = c.project_id
       WHERE c.organization_id = ?
         AND c.provider = 'privy'
         AND c.provider_credential_id = ?
         AND c.status <> 'deactivated'
       ORDER BY c.project_id, c.id
       ${options.lock ? "FOR UPDATE OF c" : ""}`,
      [organizationId, providerCredentialId]
    );
  }

  async listCredentialLineageReferences(
    organizationId: string,
    providerCredentialId: string
  ): Promise<CredentialReferenceRow[]> {
    return this.db.queryMany<CredentialReferenceRow>(
      `${CREDENTIAL_LINEAGE_SQL}
       SELECT c.id, c.project_id, p.name AS project_name, c.status,
              c.provider_account_fingerprint
       FROM custody_connections c
       JOIN credential_lineage lineage ON lineage.id = c.provider_credential_id
       JOIN projects p ON p.id = c.project_id
       WHERE c.organization_id = ?
         AND c.provider = 'privy'
         AND c.status <> 'deactivated'
       ORDER BY c.project_id, c.id`,
      [providerCredentialId, organizationId, organizationId, organizationId]
    );
  }

  async lockAuthorizedProjects(
    organizationId: string,
    userId: string,
    projectIds: readonly string[]
  ): Promise<boolean> {
    const uniqueIds = [...new Set(projectIds)].sort();
    if (uniqueIds.length === 0) return true;
    const rows = await this.db.queryMany<{ id: string }>(
      `SELECT p.id
       FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = ?
       WHERE p.organization_id = ?
         AND p.status = 'active'
         AND p.id IN (SELECT jsonb_array_elements_text(?::jsonb))
       ORDER BY p.id
       FOR UPDATE OF p, pm`,
      [userId, organizationId, JSON.stringify(uniqueIds)]
    );
    return rows.length === uniqueIds.length;
  }

  /** The caller holds the existing Project/current-Credential admission locks. */
  async nextCredentialVersion(organizationId: string, predecessorId: string): Promise<number> {
    const row = await this.db.queryOne<{ next_version: number | null }>(
      `${CREDENTIAL_LINEAGE_SQL}
       SELECT MAX(credential_version) + 1 AS next_version FROM credential_lineage`,
      [predecessorId, organizationId, organizationId]
    );
    if (!row || row.next_version === null) throw new Error("Credential lineage was not found");
    return row.next_version;
  }

  async findUnfinishedDirectChild(
    organizationId: string,
    providerCredentialId: string,
    options: { lock?: boolean } = {}
  ): Promise<LifecycleCredentialRow | null> {
    return this.db.queryOne<LifecycleCredentialRow>(
      `SELECT id, organization_id, project_id, provider, label, scope, scope_key,
              source, storage_backend, display_metadata, status, credential_version,
              rotated_from_provider_credential_id, idempotency_key,
              idempotency_fingerprint, deactivated_at, last_validated_at,
              last_failed_at, last_failure_code, secret_retention_expires_at, created_at
       FROM provider_credentials
       WHERE organization_id = ?
         AND provider = 'privy'
         AND rotated_from_provider_credential_id = ?
         AND status IN ('creating', 'pending')
       ORDER BY created_at, id
       LIMIT 1
       ${options.lock ? "FOR UPDATE" : ""}`,
      [organizationId, providerCredentialId]
    );
  }

  async recordRotationRetryUnknown(candidateId: string): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE provider_credentials
         SET last_failed_at = sdp_iso_now(),
             last_failure_code = 'provider_response_unknown',
             updated_at = sdp_iso_now()
         WHERE id = ? AND status = 'pending' AND rotated_from_provider_credential_id IS NOT NULL`,
        [candidateId]
      )) === 1
    );
  }

  async recordRotationFailure(
    candidateId: string,
    failureCode: "invalid_credentials" | "provider_account_mismatch"
  ): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE provider_credentials
         SET status = 'failed_validation',
             encrypted_secret_payload =
               CASE WHEN storage_backend = 'encrypted_db' THEN NULL
                    ELSE encrypted_secret_payload END,
             secret_retention_expires_at =
               CASE WHEN storage_backend = 'gcp_secret_manager' THEN sdp_iso_now()
                    ELSE secret_retention_expires_at END,
             last_failed_at = sdp_iso_now(),
             last_failure_code = ?,
             updated_at = sdp_iso_now()
         WHERE id = ? AND status = 'pending' AND rotated_from_provider_credential_id IS NOT NULL`,
        [failureCode, candidateId]
      )) === 1
    );
  }

  async cutOverRotation(params: {
    organizationId: string;
    predecessorId: string;
    candidateId: string;
    candidateScopeKey: string;
    expectedConnectionIds: readonly string[];
  }): Promise<boolean> {
    const moved = await this.db.execute(
      `UPDATE custody_connections
       SET provider_credential_id = ?, provider_credential_scope_key = ?, updated_at = sdp_iso_now()
       WHERE organization_id = ?
         AND provider = 'privy'
         AND provider_credential_id = ?
         AND status <> 'deactivated'`,
      [params.candidateId, params.candidateScopeKey, params.organizationId, params.predecessorId]
    );
    if (moved !== params.expectedConnectionIds.length) return false;

    const activated = await this.db.execute(
      `UPDATE provider_credentials
       SET status = 'active', last_validated_at = sdp_iso_now(), last_failed_at = NULL,
           last_failure_code = NULL, updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND status = 'pending'
         AND rotated_from_provider_credential_id = ?`,
      [params.candidateId, params.organizationId, params.predecessorId]
    );
    const retired = await this.db.execute(
      `UPDATE provider_credentials
       SET status = 'retired',
           secret_retention_expires_at = to_char(
             timezone('UTC', clock_timestamp() + interval '24 hours'),
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           ),
           updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND status = 'active'`,
      [params.predecessorId, params.organizationId]
    );
    if (activated !== 1 || retired !== 1) return false;

    await this.db.execute(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT rotated_from_provider_credential_id
         FROM provider_credentials
         WHERE id = ?
         UNION ALL
         SELECT pc.rotated_from_provider_credential_id
         FROM provider_credentials pc
         JOIN ancestors a ON pc.id = a.id
         WHERE a.id IS NOT NULL
       )
       UPDATE provider_credentials
       SET secret_retention_expires_at = sdp_iso_now(), updated_at = sdp_iso_now()
       WHERE id IN (SELECT id FROM ancestors WHERE id IS NOT NULL)
         AND status = 'retired'
         AND secret_retention_expires_at IS NOT NULL`,
      [params.predecessorId]
    );
    return true;
  }

  async rollBackCredential(params: {
    organizationId: string;
    currentId: string;
    predecessorId: string;
    predecessorScopeKey: string;
    expectedConnectionIds: readonly string[];
  }): Promise<boolean> {
    const moved = await this.db.execute(
      `UPDATE custody_connections
       SET provider_credential_id = ?, provider_credential_scope_key = ?, updated_at = sdp_iso_now()
       WHERE organization_id = ?
         AND provider = 'privy'
         AND provider_credential_id = ?
         AND status <> 'deactivated'`,
      [params.predecessorId, params.predecessorScopeKey, params.organizationId, params.currentId]
    );
    if (moved !== params.expectedConnectionIds.length) return false;
    const restored = await this.db.execute(
      `UPDATE provider_credentials
       SET status = 'active', secret_retention_expires_at = NULL,
           last_validated_at = sdp_iso_now(), last_failed_at = NULL,
           last_failure_code = NULL, updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND status = 'retired'
         AND secret_retention_expires_at::timestamptz > clock_timestamp()`,
      [params.predecessorId, params.organizationId]
    );
    const retired = await this.db.execute(
      `UPDATE provider_credentials
       SET status = 'retired', secret_retention_expires_at = sdp_iso_now(),
           updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND status = 'active'
         AND rotated_from_provider_credential_id = ?`,
      [params.currentId, params.organizationId, params.predecessorId]
    );
    return restored === 1 && retired === 1;
  }

  async lockCredentialReferenceRows(
    organizationId: string,
    connectionIds: readonly string[]
  ): Promise<void> {
    if (connectionIds.length === 0) return;
    await this.db.queryMany<{ id: string }>(
      `SELECT id FROM custody_connections
       WHERE organization_id = ? AND provider = 'privy'
         AND id IN (SELECT jsonb_array_elements_text(?::jsonb))
       ORDER BY project_id, id FOR UPDATE`,
      [organizationId, JSON.stringify(connectionIds)]
    );
  }

  async hasActiveCredentialWallet(organizationId: string, credentialId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT w.id FROM custody_connections c
       JOIN custody_wallets w ON w.custody_connection_id = c.id
       WHERE c.organization_id = ? AND c.provider = 'privy'
         AND c.provider_credential_id = ? AND w.status = 'active'
       LIMIT 1`,
      [organizationId, credentialId]
    );
    return row !== null;
  }

  async deactivateCredential(params: {
    organizationId: string;
    credentialId: string;
    expectedStatus: "pending" | "active";
    predecessorId: string | null;
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE provider_credentials candidate
         SET status = 'deactivated',
             encrypted_secret_payload =
               CASE WHEN storage_backend = 'encrypted_db' THEN NULL
                    ELSE encrypted_secret_payload END,
             secret_retention_expires_at =
               CASE WHEN storage_backend = 'gcp_secret_manager' THEN sdp_iso_now()
                    ELSE secret_retention_expires_at END,
             deactivated_at = sdp_iso_now(), updated_at = sdp_iso_now()
         WHERE candidate.id = ?
           AND candidate.organization_id = ?
           AND candidate.provider = 'privy'
           AND candidate.status = ?
           AND candidate.rotated_from_provider_credential_id IS NOT DISTINCT FROM ?
           AND NOT EXISTS (
             SELECT 1 FROM custody_connections c
             WHERE c.provider_credential_id = candidate.id AND c.status <> 'deactivated'
           )
           AND NOT EXISTS (
             SELECT 1
             FROM custody_connections c
             JOIN custody_wallets w
               ON w.custody_connection_id = c.id AND w.status = 'active'
             WHERE c.provider_credential_id = candidate.id
           )`,
        [params.credentialId, params.organizationId, params.expectedStatus, params.predecessorId]
      )) === 1
    );
  }

  /**
   * Paginated dashboard read: every connection for a project scope, newest
   * first, joined with the safe credential columns the dashboard may show.
   * Secret references never leave this query. Distinct from
   * listProjectConnections, the setup planner's locking read.
   */
  async listProjectConnectionsPage(
    organizationId: string,
    projectId: string,
    options: { limit: number; offset: number }
  ): Promise<{ connections: ProjectConnectionListRow[]; total: number }> {
    const totalRow = await this.db.queryOne<{ total: number | string }>(
      `SELECT COUNT(*) AS total
         FROM custody_connections
        WHERE organization_id = ? AND project_id = ?`,
      [organizationId, projectId]
    );
    const connections = await this.db.queryMany<ProjectConnectionListRow>(
      `SELECT c.id,
              c.provider,
              c.status AS connection_status,
              c.setup_metadata,
              c.last_check_status,
              c.last_check_at,
              c.last_check_failure_code,
              c.activated_at,
              c.created_at,
              pc.label AS credential_label,
              pc.status AS credential_status,
              c.provider_account_fingerprint,
              c.default_custody_wallet_id,
              default_wallet.wallet_id AS default_wallet_id,
              default_wallet.public_key AS default_wallet_public_key,
              default_wallet.status AS default_wallet_status,
              EXISTS (
                SELECT 1
                FROM custody_scope_defaults selected
                WHERE selected.organization_id = c.organization_id
                  AND selected.project_id = c.project_id
                  AND selected.default_custody_connection_id = c.id
              ) AS is_selected
         FROM custody_connections c
         JOIN provider_credentials pc ON pc.id = c.provider_credential_id
         LEFT JOIN custody_wallets default_wallet
           ON default_wallet.id = c.default_custody_wallet_id
          AND default_wallet.custody_connection_id = c.id
        WHERE c.organization_id = ? AND c.project_id = ?
        ORDER BY c.created_at DESC, c.id DESC
        LIMIT ? OFFSET ?`,
      [organizationId, projectId, options.limit, options.offset]
    );
    return { connections, total: Number(totalRow?.total ?? 0) };
  }

  async findConnectionIdsForCredentialLineage(
    organizationId: string,
    projectId: string,
    providerCredentialId: string
  ): Promise<string[]> {
    const rows = await this.db.queryMany<{ id: string }>(
      `WITH RECURSIVE credential_lineage(id) AS (
         SELECT id
         FROM provider_credentials
         WHERE id = ?
           AND organization_id = ?
           AND project_id = ?
           AND provider = 'privy'
           AND scope = 'project'
         UNION
         SELECT next.id
         FROM provider_credentials next
         JOIN credential_lineage previous
           ON next.rotated_from_provider_credential_id = previous.id
         WHERE next.organization_id = ?
           AND next.project_id = ?
           AND next.provider = 'privy'
           AND next.scope = 'project'
       )
       SELECT DISTINCT c.id
       FROM custody_connections c
       JOIN credential_lineage lineage ON lineage.id = c.provider_credential_id
       WHERE c.organization_id = ?
         AND c.project_id = ?
         AND c.provider = 'privy'
       ORDER BY c.id`,
      [
        providerCredentialId,
        organizationId,
        projectId,
        organizationId,
        projectId,
        organizationId,
        projectId,
      ]
    );
    return rows.map((row) => row.id);
  }

  async hasActiveInstallationWallet(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<boolean> {
    return !!(await this.db.queryOne<{ id: string }>(
      `SELECT w.id FROM custody_wallets w
       JOIN custody_connections c ON c.id = w.custody_connection_id
       WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ?
         AND c.provider = 'privy' AND w.status = 'active'
       LIMIT 1`,
      [connectionId, organizationId, projectId]
    ));
  }

  async deactivateInstallationConnection(params: {
    organizationId: string;
    projectId: string;
    connectionId: string;
    credentialId: string;
    credentialStatus: ProviderCredentialStatus;
    observedStatus: "failed" | "active";
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE custody_connections c
         SET status = 'deactivated', deactivated_at = sdp_iso_now(), updated_at = sdp_iso_now()
         WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ?
           AND c.provider = 'privy' AND c.provider_credential_id = ?
           AND c.status = ? AND c.status IN ('failed', 'active')
           AND EXISTS (
             SELECT 1 FROM provider_credentials pc
             WHERE pc.id = c.provider_credential_id AND pc.organization_id = c.organization_id
               AND pc.provider = c.provider AND pc.scope_key = c.provider_credential_scope_key
               AND (pc.scope = 'organization' OR pc.project_id = c.project_id)
               AND pc.status = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM custody_wallets w
             WHERE w.custody_connection_id = c.id AND w.status = 'active'
           )`,
        [
          params.connectionId,
          params.organizationId,
          params.projectId,
          params.credentialId,
          params.observedStatus,
          params.credentialStatus,
        ]
      )) === 1
    );
  }

  async findInstallationConnection(
    organizationId: string,
    projectId: string,
    connectionId: string,
    options: { lock?: boolean; excludedCreatingCredentialId?: string } = {}
  ): Promise<InstallationConnectionState | null> {
    return this.db.queryOne<InstallationConnectionState>(
      `SELECT c.id, c.organization_id, c.project_id, c.provider, c.scope,
              c.provider_credential_id, c.provider_credential_scope_key,
              c.default_custody_wallet_id, c.provider_account_fingerprint,
              c.request_delay_ms,
              c.status, c.setup_metadata, c.last_check_status, c.last_check_at,
              c.last_check_failure_code, c.activated_at, c.deactivated_at, c.created_at,
              pc.label AS credential_label,
              pc.status AS credential_status,
              pc.credential_version,
              pc.scope AS credential_scope,
              pc.project_id AS credential_project_id,
              pc.source AS credential_source,
              pc.storage_backend AS credential_storage_backend,
              pc.secret_ref AS credential_secret_ref,
              pc.secret_version_ref AS credential_secret_version_ref,
              pc.encrypted_secret_payload AS credential_encrypted_secret_payload,
              pc.display_metadata AS credential_display_metadata,
              pc.created_at AS credential_created_at,
              EXISTS (
                SELECT 1 FROM custody_wallets owned
                WHERE owned.custody_connection_id = c.id
              ) AS has_owned_wallet,
              (EXISTS (
                SELECT 1 FROM custody_connections sibling
                WHERE sibling.organization_id = c.organization_id
                  AND sibling.project_id = c.project_id
                  AND sibling.provider = c.provider
                  AND sibling.id <> c.id
                  AND sibling.status IN ('pending', 'checking')
              ) OR EXISTS (
                SELECT 1 FROM provider_credentials creating
                WHERE creating.organization_id = c.organization_id
                  AND creating.project_id = c.project_id
                  AND creating.provider = c.provider
                  AND creating.id IS DISTINCT FROM ?
                  AND ${CREATING_SUBMISSION}
              )) AS has_sibling_unfinished,
              EXISTS (
                SELECT 1 FROM custody_scope_defaults selected
                WHERE selected.organization_id = c.organization_id
                  AND selected.project_id = c.project_id
                  AND selected.default_custody_connection_id = c.id
              ) AS is_selected
       FROM custody_connections c
       JOIN provider_credentials pc ON pc.id = c.provider_credential_id
       WHERE c.id = ?
         AND c.organization_id = ?
         AND c.project_id = ?
         AND c.provider = 'privy'
       ${options.lock ? "FOR UPDATE OF c, pc" : ""}`,
      [options.excludedCreatingCredentialId ?? null, connectionId, organizationId, projectId]
    );
  }

  async acquireInstallationLease(params: {
    connectionId: string;
    providerCredentialId: string;
    credentialSource: "stored" | "runtime";
    expectedStatus: "pending" | "checking";
    expectedLastCheckStatus: string | null;
    expectedLastCheckAt: string | null;
  }): Promise<string | null> {
    const row = await this.db.queryOne<{ last_check_at: string }>(
      `UPDATE custody_connections c
       SET status = 'checking',
           last_check_status = 'running',
           last_check_at = CASE
             WHEN c.last_check_at IS NULL THEN sdp_iso_now()
             ELSE GREATEST(
               sdp_iso_now(),
               to_char(
                 timezone('UTC', c.last_check_at::timestamptz + interval '1 millisecond'),
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )
             )
           END,
           last_check_failure_code = NULL,
           updated_at = sdp_iso_now()
       WHERE c.id = ?
         AND c.provider_credential_id = ?
         AND c.status = ?
         AND c.last_check_status IS NOT DISTINCT FROM ?
         AND c.last_check_at IS NOT DISTINCT FROM ?
         AND c.default_custody_wallet_id IS NULL
         AND c.activated_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM custody_wallets owned
           WHERE owned.custody_connection_id = c.id
         )
         AND EXISTS (
           SELECT 1 FROM provider_credentials pc
           WHERE pc.id = c.provider_credential_id
             AND pc.status = 'pending'
             AND pc.source = ?
             AND pc.scope = 'project'
             AND pc.project_id = c.project_id
         )
       RETURNING c.last_check_at`,
      [
        params.connectionId,
        params.providerCredentialId,
        params.expectedStatus,
        params.expectedLastCheckStatus,
        params.expectedLastCheckAt,
        params.credentialSource,
      ]
    );
    return row?.last_check_at ?? null;
  }

  async acquireRuntimeFailureRetryLease(params: {
    connectionId: string;
    providerCredentialId: string;
    expectedLastCheckAt: string;
    expectedFailureCode: "invalid_credentials" | "provider_account_already_connected";
  }): Promise<string | null> {
    const row = await this.db.queryOne<{ last_check_at: string }>(
      `UPDATE custody_connections c
       SET status = 'checking',
           last_check_status = 'running',
           last_check_at = GREATEST(
             sdp_iso_now(),
             to_char(
               timezone('UTC', c.last_check_at::timestamptz + interval '1 millisecond'),
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
           ),
           last_check_failure_code = NULL,
           updated_at = sdp_iso_now()
       WHERE c.id = ?
         AND c.provider_credential_id = ?
         AND c.status = 'failed'
         AND c.last_check_status = 'failed'
         AND c.last_check_at = ?
         AND c.last_check_failure_code = ?
         AND c.provider_account_fingerprint IS NULL
         AND c.default_custody_wallet_id IS NULL
         AND c.activated_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM custody_wallets owned
           WHERE owned.custody_connection_id = c.id
         )
         AND NOT EXISTS (
           SELECT 1 FROM custody_connections sibling
           WHERE sibling.organization_id = c.organization_id
             AND sibling.project_id = c.project_id
             AND sibling.provider = c.provider
             AND sibling.id <> c.id
             AND sibling.status IN ('pending', 'checking')
         )
         AND NOT EXISTS (
           SELECT 1 FROM provider_credentials creating
           WHERE creating.organization_id = c.organization_id
             AND creating.project_id = c.project_id
             AND creating.provider = c.provider
             AND ${CREATING_SUBMISSION}
         )
         AND EXISTS (
           SELECT 1 FROM provider_credentials pc
           WHERE pc.id = c.provider_credential_id
             AND pc.status = 'failed_validation'
             AND pc.last_failure_code = ?
             AND pc.source = 'runtime'
             AND pc.storage_backend = 'runtime_env'
             AND pc.scope = 'project'
             AND pc.project_id = c.project_id
         )
       RETURNING c.last_check_at`,
      [
        params.connectionId,
        params.providerCredentialId,
        params.expectedLastCheckAt,
        params.expectedFailureCode,
        params.expectedFailureCode,
      ]
    );
    if (!row) {
      return null;
    }

    const resetCredential = await this.db.execute(
      `UPDATE provider_credentials
       SET status = 'pending',
           last_failure_code = NULL,
           updated_at = sdp_iso_now()
       WHERE id = ?
         AND status = 'failed_validation'
         AND last_failure_code = ?
         AND source = 'runtime'
         AND storage_backend = 'runtime_env'
         AND scope = 'project'`,
      [params.providerCredentialId, params.expectedFailureCode]
    );
    if (resetCredential !== 1) {
      throw new Error("Runtime installation Credential changed during retry admission");
    }
    return row.last_check_at;
  }

  async reserveProviderAccountFingerprint(params: {
    connectionId: string;
    providerCredentialId: string;
    leaseToken: string;
    fingerprint: string;
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE custody_connections c
         SET provider_account_fingerprint = ?, updated_at = sdp_iso_now()
         WHERE c.id = ?
           AND c.provider_credential_id = ?
           AND c.status = 'checking'
           AND c.last_check_status = 'running'
           AND c.last_check_at = ?
           AND c.provider_account_fingerprint IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM custody_wallets owned
             WHERE owned.custody_connection_id = c.id
           )`,
        [params.fingerprint, params.connectionId, params.providerCredentialId, params.leaseToken]
      )) === 1
    );
  }

  async recordInstallationSuccess(params: {
    providerCredentialId: string;
    connectionId: string;
    leaseToken: string;
    providerWalletId: string;
    publicKey: string;
    label?: string;
  }): Promise<ProviderCredentialRow | null> {
    const custodyWalletId = `cwlt_${crypto.randomUUID()}`;
    await this.db.execute(
      `INSERT INTO custody_wallets (
         id, custody_config_id, custody_connection_id, wallet_id,
         public_key, label, status, updated_at
       ) VALUES (?, NULL, ?, ?, ?, ?, 'active', sdp_iso_now())`,
      [
        custodyWalletId,
        params.connectionId,
        params.providerWalletId,
        params.publicKey,
        params.label ?? null,
      ]
    );

    const updatedConnection = await this.db.execute(
      `UPDATE custody_connections
       SET default_custody_wallet_id = ?,
           status = 'active',
           setup_metadata = setup_metadata - 'pendingWalletLabel',
           last_check_status = 'success',
           last_check_failure_code = NULL,
           activated_at = sdp_iso_now(),
           updated_at = sdp_iso_now()
       WHERE id = ?
         AND provider_credential_id = ?
         AND status = 'checking'
         AND last_check_status = 'running'
         AND last_check_at = ?
         AND provider_account_fingerprint IS NOT NULL`,
      [custodyWalletId, params.connectionId, params.providerCredentialId, params.leaseToken]
    );
    if (updatedConnection !== 1) {
      throw new Error("Installation changed during success persistence");
    }

    return this.db.queryOne<ProviderCredentialRow>(
      `UPDATE provider_credentials
       SET status = 'active',
           last_validated_at = sdp_iso_now(),
           last_failure_code = NULL,
           updated_at = sdp_iso_now()
       WHERE id = ? AND status = 'pending'
       RETURNING id, organization_id, project_id, provider, label, scope, scope_key,
                 display_metadata, status, credential_version,
                 rotated_from_provider_credential_id, idempotency_key,
                 idempotency_fingerprint, last_failure_code, created_at`,
      [params.providerCredentialId]
    );
  }

  async recordInstallationFailure(params: {
    providerCredentialId: string;
    connectionId: string;
    leaseToken: string;
    failureCode: "invalid_credentials" | "provider_account_already_connected" | "wallet_conflict";
  }): Promise<ProviderCredentialRow | null> {
    const updatedConnection = await this.db.execute(
      `UPDATE custody_connections
       SET status = 'failed',
           last_check_status = 'failed',
           last_check_failure_code = ?,
           updated_at = sdp_iso_now()
       WHERE id = ?
         AND provider_credential_id = ?
         AND status = 'checking'
         AND last_check_status = 'running'
         AND last_check_at = ?
         AND default_custody_wallet_id IS NULL
         AND activated_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM custody_wallets owned
           WHERE owned.custody_connection_id = custody_connections.id
         )`,
      [params.failureCode, params.connectionId, params.providerCredentialId, params.leaseToken]
    );
    if (updatedConnection !== 1) {
      return null;
    }

    const credential = await this.db.queryOne<ProviderCredentialRow>(
      `UPDATE provider_credentials
       SET status = 'failed_validation',
           encrypted_secret_payload =
             CASE WHEN storage_backend = 'encrypted_db' THEN NULL
                  ELSE encrypted_secret_payload END,
           last_failed_at = sdp_iso_now(),
           last_failure_code = ?,
           updated_at = sdp_iso_now()
       WHERE id = ? AND status = 'pending'
       RETURNING id, organization_id, project_id, provider, label, scope, scope_key,
                 display_metadata, status, credential_version,
                 rotated_from_provider_credential_id, idempotency_key,
                 idempotency_fingerprint, last_failure_code, created_at`,
      [params.failureCode, params.providerCredentialId]
    );
    if (!credential) {
      throw new Error("Installation Credential changed during failure persistence");
    }
    return credential;
  }

  async recordInstallationRetryUnknown(params: {
    providerCredentialId: string;
    connectionId: string;
    leaseToken: string;
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE custody_connections
         SET status = 'pending',
             last_check_status = 'retry_unknown',
             last_check_failure_code = 'provider_response_unknown',
             updated_at = sdp_iso_now()
         WHERE id = ?
           AND provider_credential_id = ?
           AND status = 'checking'
           AND last_check_status = 'running'
           AND last_check_at = ?
           AND default_custody_wallet_id IS NULL
           AND activated_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM custody_wallets owned
             WHERE owned.custody_connection_id = custody_connections.id
           )`,
        [params.connectionId, params.providerCredentialId, params.leaseToken]
      )) === 1
    );
  }

  async cancelInstallation(params: {
    connectionId: string;
    providerCredentialId: string;
    credentialSource: "stored" | "runtime";
    expectedStatus: "pending" | "checking";
    expectedLastCheckStatus: string | null;
    expectedLastCheckAt: string | null;
  }): Promise<boolean> {
    const updatedConnection = await this.db.execute(
      `UPDATE custody_connections
       SET status = 'deactivated',
           last_check_status = CASE
             WHEN status = 'checking' AND last_check_status = 'running' THEN 'retry_unknown'
             ELSE last_check_status
           END,
           last_check_failure_code = CASE
             WHEN status = 'checking' AND last_check_status = 'running'
               THEN 'provider_response_unknown'
             ELSE last_check_failure_code
           END,
           deactivated_at = sdp_iso_now(),
           updated_at = sdp_iso_now()
       WHERE id = ?
         AND provider_credential_id = ?
         AND status = ?
         AND last_check_status IS NOT DISTINCT FROM ?
         AND last_check_at IS NOT DISTINCT FROM ?
         AND provider_account_fingerprint IS NULL
         AND default_custody_wallet_id IS NULL
         AND activated_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM custody_wallets owned
           WHERE owned.custody_connection_id = custody_connections.id
         )`,
      [
        params.connectionId,
        params.providerCredentialId,
        params.expectedStatus,
        params.expectedLastCheckStatus,
        params.expectedLastCheckAt,
      ]
    );
    if (updatedConnection !== 1) {
      return false;
    }

    const updatedCredential = await this.db.execute(
      `UPDATE provider_credentials
       SET status = 'deactivated',
           encrypted_secret_payload =
             CASE WHEN storage_backend = 'encrypted_db' THEN NULL
                  ELSE encrypted_secret_payload END,
           deactivated_at = sdp_iso_now(),
           updated_at = sdp_iso_now()
       WHERE id = ?
         AND status = 'pending'
         AND source = ?
         AND scope = 'project'`,
      [params.providerCredentialId, params.credentialSource]
    );
    if (updatedCredential !== 1) {
      throw new Error("Installation Credential changed during cancellation");
    }
    return true;
  }

  async insertCredential(params: {
    id: string;
    organizationId: string;
    projectId: string | null;
    /** Provider family this credential belongs to; RPC connections reuse this insert. */
    provider: string;
    label: string;
    scope: "organization" | "project";
    source: "stored" | "runtime";
    status?: "creating" | "pending";
    stored: StoredCredentialSecret;
    displayMetadata: Record<string, string>;
    version: number;
    rotatedFromId: string | null;
    idempotencyKey: string;
    idempotencyFingerprint: string;
    createdBy: string;
    ownsGcpContainer?: boolean;
  }): Promise<ProviderCredentialRow> {
    const scopeKey = params.scope === "organization" ? "__organization__" : params.projectId;
    const row = await this.db.queryOne<ProviderCredentialRow>(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, secret_ref, secret_version_ref, encrypted_secret_payload,
         display_metadata, status, credential_version,
         rotated_from_provider_credential_id, idempotency_key,
         idempotency_fingerprint, created_by, secret_next_scan_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN clock_timestamp() ELSE NULL END
       )
       RETURNING id, organization_id, project_id, provider, label, scope, scope_key,
                 display_metadata, status, credential_version,
                 rotated_from_provider_credential_id, idempotency_key,
                 idempotency_fingerprint, last_failure_code, created_at`,
      [
        params.id,
        params.organizationId,
        params.projectId,
        params.provider,
        params.label,
        params.scope,
        params.source,
        params.stored.storageBackend,
        params.stored.secretRef ?? null,
        params.stored.secretVersionRef ?? null,
        params.stored.encryptedSecretPayload ?? null,
        JSON.stringify(params.displayMetadata),
        params.status ?? "pending",
        params.version,
        params.rotatedFromId,
        params.idempotencyKey,
        params.idempotencyFingerprint,
        params.createdBy,
        params.ownsGcpContainer ?? false,
      ]
    );

    if (!row || row.scope_key !== scopeKey) {
      throw new Error("Provider credential insert did not return the expected scope");
    }
    return row;
  }

  async findCreatingSubmission(
    organizationId: string,
    projectId: string
  ): Promise<ProviderCredentialRow | null> {
    return this.db.queryOne<ProviderCredentialRow>(
      `SELECT creating.id, creating.organization_id, creating.project_id, creating.provider,
              creating.label, creating.scope, creating.scope_key, creating.display_metadata,
              creating.status, creating.credential_version, creating.rotated_from_provider_credential_id,
              creating.idempotency_key, creating.idempotency_fingerprint,
              creating.last_failure_code, creating.created_at
       FROM provider_credentials creating
       WHERE creating.organization_id = ? AND creating.project_id = ? AND creating.provider = 'privy'
         AND ${CREATING_SUBMISSION}
       ORDER BY creating.created_at, creating.id LIMIT 1`,
      [organizationId, projectId]
    );
  }

  async finalizeCredentialCreation(params: {
    organizationId: string;
    credentialId: string;
    secretRef: string;
    secretVersionRef: string;
  }): Promise<ProviderCredentialRow | null> {
    if (!params.secretVersionRef.trim()) return null;
    return this.db.queryOne<ProviderCredentialRow>(
      `UPDATE provider_credentials
       SET status = 'pending', secret_version_ref = ?, updated_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND provider = 'privy'
         AND status = 'creating' AND source = 'stored' AND storage_backend = 'gcp_secret_manager'
         AND secret_ref = ? AND secret_version_ref IS NULL
       RETURNING id, organization_id, project_id, provider, label, scope, scope_key,
                 display_metadata, status, credential_version,
                 rotated_from_provider_credential_id, idempotency_key,
                 idempotency_fingerprint, last_failure_code, created_at`,
      [params.secretVersionRef, params.credentialId, params.organizationId, params.secretRef]
    );
  }

  async abandonCredentialCreation(params: {
    organizationId: string;
    credentialId: string;
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE provider_credentials pc
         SET status = 'deactivated', deactivated_at = sdp_iso_now(),
             last_failed_at = sdp_iso_now(), last_failure_code = 'secret_creation_abandoned',
             secret_retention_expires_at = sdp_iso_now(), updated_at = sdp_iso_now()
         WHERE pc.id = ? AND pc.organization_id = ? AND pc.provider = 'privy'
           AND pc.status = 'creating' AND pc.storage_backend = 'gcp_secret_manager'
           AND NOT EXISTS (
             SELECT 1 FROM custody_connections c
             WHERE c.provider_credential_id = pc.id AND c.status <> 'deactivated'
           )`,
        [params.credentialId, params.organizationId]
      )) === 1
    );
  }

  async insertConnection(params: {
    id: string;
    organizationId: string;
    projectId: string;
    providerCredentialId: string;
    providerCredentialScopeKey: string;
    requestDelayMs?: number;
    pendingWalletLabel?: string;
    createdBy: string;
  }): Promise<CustodyConnectionRow> {
    const row = await this.db.queryOne<CustodyConnectionRow>(
      `INSERT INTO custody_connections (
       id, organization_id, project_id, provider, scope,
         provider_credential_id, provider_credential_scope_key,
         request_delay_ms, setup_metadata, status, created_by
       ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, ?, ?, 'pending', ?)
       RETURNING id, organization_id, project_id, provider, scope,
                 provider_credential_id, provider_credential_scope_key,
                 default_custody_wallet_id, provider_account_fingerprint,
                 request_delay_ms,
                 status, setup_metadata,
                 last_check_status, last_check_at, last_check_failure_code,
                 activated_at, deactivated_at, created_at`,
      [
        params.id,
        params.organizationId,
        params.projectId,
        params.providerCredentialId,
        params.providerCredentialScopeKey,
        params.requestDelayMs ?? null,
        JSON.stringify(
          params.pendingWalletLabel ? { pendingWalletLabel: params.pendingWalletLabel } : {}
        ),
        params.createdBy,
      ]
    );
    if (!row) {
      throw new Error("Custody connection insert returned no row");
    }
    return row;
  }

  async resetFailedConnection(params: {
    id: string;
    expectedProviderCredentialId: string;
    providerCredentialId: string;
    providerCredentialScopeKey: string;
    requestDelayMs?: number;
    pendingWalletLabel?: string;
  }): Promise<CustodyConnectionRow | null> {
    return this.db.queryOne<CustodyConnectionRow>(
      `UPDATE custody_connections
       SET provider_credential_id = ?,
           provider_credential_scope_key = ?,
           request_delay_ms = ?,
           status = 'pending',
           setup_metadata = CAST(? AS jsonb),
           last_check_status = NULL,
           last_check_at = NULL,
           last_check_failure_code = NULL,
           updated_at = sdp_iso_now()
       WHERE id = ?
         AND provider_credential_id = ?
         AND status = 'failed'
         AND provider_account_fingerprint IS NULL
         AND default_custody_wallet_id IS NULL
         AND activated_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM custody_wallets owned
           WHERE owned.custody_connection_id = custody_connections.id
         )
         AND EXISTS (
           SELECT 1 FROM provider_credentials current_credential
           WHERE current_credential.id = custody_connections.provider_credential_id
             AND current_credential.status = 'failed_validation'
         )
         AND NOT EXISTS (
           SELECT 1 FROM custody_connections sibling
           WHERE sibling.organization_id = custody_connections.organization_id
             AND sibling.project_id = custody_connections.project_id
             AND sibling.provider = custody_connections.provider
             AND sibling.id <> custody_connections.id
             AND sibling.status IN ('pending', 'checking')
         )
       RETURNING id, organization_id, project_id, provider, scope,
                 provider_credential_id, provider_credential_scope_key,
                 default_custody_wallet_id, provider_account_fingerprint,
                 request_delay_ms,
                 status, setup_metadata,
                 last_check_status, last_check_at, last_check_failure_code,
                 activated_at, deactivated_at, created_at`,
      [
        params.providerCredentialId,
        params.providerCredentialScopeKey,
        params.requestDelayMs ?? null,
        JSON.stringify(
          params.pendingWalletLabel ? { pendingWalletLabel: params.pendingWalletLabel } : {}
        ),
        params.id,
        params.expectedProviderCredentialId,
      ]
    );
  }
}

export function getPendingWalletLabel(value: unknown): string | undefined {
  const label = parsePostgresJsonOr<Record<string, unknown>>(value, {}).pendingWalletLabel;
  return typeof label === "string" ? label : undefined;
}
