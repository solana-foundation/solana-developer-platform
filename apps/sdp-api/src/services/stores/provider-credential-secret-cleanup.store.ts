import type { DatabaseExecutor } from "@/db";

export interface RetainedProviderCredentialSecretRow {
  id: string;
  organization_id: string;
  provider: string;
  storage_backend: "encrypted_db" | "gcp_secret_manager";
  status: string;
  secret_ref: string | null;
  secret_version_ref: string | null;
  secret_retention_expires_at: string | null;
}

export interface CredentialSecretContainerRow {
  id: string;
  organization_id: string;
  secret_ref: string;
}

const UNREFERENCED = `NOT EXISTS (
  SELECT 1 FROM custody_connections c
  WHERE c.provider_credential_id = pc.id AND c.status <> 'deactivated'
)`;
// Failed installation keeps its connection for replacement/history, but its
// rejected stored Credential is immutable and must no longer retain a payload.
const GCP_UNREFERENCED = `NOT EXISTS (
  SELECT 1 FROM custody_connections c
  WHERE c.provider_credential_id = pc.id AND c.status <> 'deactivated'
    AND NOT (pc.status = 'failed_validation' AND c.status = 'failed')
)`;
const RETENTION_DUE = `(pc.secret_retention_expires_at::timestamptz <= clock_timestamp()
  OR NOT EXISTS (SELECT 1 FROM provider_credentials child
    WHERE child.rotated_from_provider_credential_id = pc.id AND child.status = 'active'))`;
const GCP_TERMINAL = `(pc.status IN ('failed_validation', 'deactivated')
  OR (pc.status = 'retired' AND (pc.secret_retention_expires_at IS NULL OR ${RETENTION_DUE})))`;
const COLUMNS = `pc.id, pc.organization_id, pc.provider, pc.storage_backend, pc.status,
  pc.secret_ref, pc.secret_version_ref, pc.secret_retention_expires_at`;

export class ProviderCredentialSecretCleanupStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async listDueEncrypted(limit: number): Promise<RetainedProviderCredentialSecretRow[]> {
    return this.db.queryMany(
      `SELECT ${COLUMNS} FROM provider_credentials pc
       WHERE pc.source = 'stored' AND pc.storage_backend = 'encrypted_db'
         AND pc.status = 'retired' AND pc.secret_retention_expires_at IS NOT NULL
         AND ${RETENTION_DUE} AND ${UNREFERENCED}
       ORDER BY pc.updated_at, pc.id LIMIT ?`,
      [limit]
    );
  }

  async cleanupEncryptedDb(params: {
    id: string;
    expectedRetentionExpiresAt: string;
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE provider_credentials pc SET encrypted_secret_payload = NULL,
         secret_retention_expires_at = NULL, updated_at = sdp_iso_now()
       WHERE pc.id = ? AND pc.source = 'stored' AND pc.storage_backend = 'encrypted_db'
         AND pc.status = 'retired' AND pc.secret_retention_expires_at = ?
         AND ${RETENTION_DUE} AND ${UNREFERENCED}`,
        [params.id, params.expectedRetentionExpiresAt]
      )) === 1
    );
  }

  async listDueContainers(now: Date, limit: number): Promise<CredentialSecretContainerRow[]> {
    return this.db.queryMany(
      `SELECT id, organization_id, secret_ref FROM provider_credentials
       WHERE provider = 'privy' AND source = 'stored' AND storage_backend = 'gcp_secret_manager'
         AND secret_next_scan_at <= ?::timestamptz
       ORDER BY secret_next_scan_at, id LIMIT ?`,
      [now.toISOString(), limit]
    );
  }

  async advanceContainerScan(owner: CredentialSecretContainerRow, now: Date): Promise<boolean> {
    const next = new Date(now.getTime() + 5 * 60_000).toISOString();
    return (
      (await this.db.execute(
        `UPDATE provider_credentials SET secret_next_scan_at = ?::timestamptz
       WHERE id = ? AND organization_id = ? AND secret_ref = ?
         AND provider = 'privy' AND source = 'stored' AND storage_backend = 'gcp_secret_manager'
         AND secret_next_scan_at <= ?::timestamptz`,
        [next, owner.id, owner.organization_id, owner.secret_ref, now.toISOString()]
      )) === 1
    );
  }

  async cancelStaleCreations(owner: CredentialSecretContainerRow): Promise<void> {
    // Two minutes permits cancellation; it does not prove GCP has stopped.
    await this.db.execute(
      `UPDATE provider_credentials pc SET status = 'deactivated',
         deactivated_at = sdp_iso_now(), last_failed_at = sdp_iso_now(),
         last_failure_code = 'secret_creation_abandoned',
         secret_retention_expires_at = sdp_iso_now(), updated_at = sdp_iso_now()
       WHERE pc.organization_id = ? AND pc.secret_ref = ? AND pc.provider = 'privy'
         AND pc.source = 'stored' AND pc.storage_backend = 'gcp_secret_manager'
         AND pc.status = 'creating'
         AND pc.created_at::timestamptz <= clock_timestamp() - interval '2 minutes'
         AND ${UNREFERENCED}`,
      [owner.organization_id, owner.secret_ref]
    );
  }

  async listContainerCredentials(
    secretRef: string
  ): Promise<RetainedProviderCredentialSecretRow[]> {
    // Deliberately includes every reference, not just active rows or the owner.
    return this.db.queryMany(
      `SELECT ${COLUMNS} FROM provider_credentials pc WHERE secret_ref = ?`,
      [secretRef]
    );
  }

  async listPendingDestructions(
    owner: CredentialSecretContainerRow,
    limit: number
  ): Promise<RetainedProviderCredentialSecretRow[]> {
    return this.db.queryMany(
      `SELECT ${COLUMNS} FROM provider_credentials pc
       WHERE pc.organization_id = ? AND pc.secret_ref = ? AND pc.provider = 'privy'
         AND pc.source = 'stored' AND pc.storage_backend = 'gcp_secret_manager'
         AND pc.secret_version_ref IS NOT NULL AND pc.secret_retention_expires_at IS NOT NULL
         AND ${GCP_TERMINAL} AND ${GCP_UNREFERENCED}
       ORDER BY pc.updated_at, pc.id LIMIT ?`,
      [owner.organization_id, owner.secret_ref, limit]
    );
  }

  async fenceGcpCleanupCandidate(params: {
    id: string;
    expectedSecretVersionRef: string;
  }): Promise<RetainedProviderCredentialSecretRow | null> {
    return this.db.queryOne(
      `UPDATE provider_credentials pc SET updated_at = sdp_iso_now()
       WHERE pc.id = ? AND pc.provider = 'privy' AND pc.source = 'stored'
         AND pc.storage_backend = 'gcp_secret_manager' AND pc.secret_version_ref = ?
         AND ${GCP_TERMINAL} AND ${GCP_UNREFERENCED}
         AND NOT EXISTS (SELECT 1 FROM provider_credentials other
           WHERE other.id <> pc.id
             AND regexp_replace(other.secret_version_ref, '^projects/[^/]+/', '') =
                 regexp_replace(pc.secret_version_ref, '^projects/[^/]+/', ''))
       RETURNING ${COLUMNS}`,
      [params.id, params.expectedSecretVersionRef]
    );
  }

  async clearGcpRetentionMarker(params: {
    id: string;
    expectedRetentionExpiresAt: string | null;
    expectedSecretVersionRef: string;
  }): Promise<boolean> {
    if (params.expectedRetentionExpiresAt === null) return true;
    return (
      (await this.db.execute(
        `UPDATE provider_credentials pc SET secret_retention_expires_at = NULL,
         secret_cleanup_next_attempt_at = NULL, updated_at = sdp_iso_now()
       WHERE pc.id = ? AND pc.provider = 'privy' AND pc.source = 'stored'
         AND pc.storage_backend = 'gcp_secret_manager' AND pc.secret_version_ref = ?
         AND pc.secret_retention_expires_at = ? AND ${GCP_TERMINAL} AND ${GCP_UNREFERENCED}`,
        [params.id, params.expectedSecretVersionRef, params.expectedRetentionExpiresAt]
      )) === 1
    );
  }

  async recordAcknowledgedGcpVersion(params: {
    id: string;
    secretRef: string;
    secretVersionRef: string;
  }): Promise<void> {
    // Only the writer's exact acknowledgement can bind a version to an attempt.
    // Clear legacy absence fields when late positive evidence disproves them;
    // existing observations remain historical, not a parallel cleanup protocol.
    const changed = await this.db.execute(
      `UPDATE provider_credentials SET
         secret_retention_expires_at = CASE WHEN secret_version_ref IS NULL
           THEN COALESCE(secret_retention_expires_at, sdp_iso_now()) ELSE secret_retention_expires_at END,
         secret_cleanup_outcome = CASE WHEN secret_version_ref IS NULL THEN NULL ELSE secret_cleanup_outcome END,
         secret_cleanup_absent_since = CASE WHEN secret_version_ref IS NULL THEN NULL ELSE secret_cleanup_absent_since END,
         secret_version_ref = COALESCE(secret_version_ref, ?), updated_at = sdp_iso_now()
       WHERE id = ? AND secret_ref = ? AND provider = 'privy' AND source = 'stored'
         AND storage_backend = 'gcp_secret_manager' AND status = 'deactivated'
         AND last_failure_code = 'secret_creation_abandoned'
         AND (secret_version_ref IS NULL OR secret_version_ref = ?)`,
      [params.secretVersionRef, params.id, params.secretRef, params.secretVersionRef]
    );
    if (changed !== 1)
      throw new Error("Abandoned Credential changed while recording its acknowledged version");
  }
}
