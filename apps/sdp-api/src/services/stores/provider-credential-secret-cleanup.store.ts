import type { DatabaseExecutor } from "@/db";

export interface RetainedProviderCredentialSecretRow {
  id: string;
  provider: string;
  storage_backend: "encrypted_db" | "gcp_secret_manager";
  secret_version_ref: string | null;
  secret_retention_expires_at: string;
}

export class ProviderCredentialSecretCleanupStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async listDue(limit: number): Promise<RetainedProviderCredentialSecretRow[]> {
    return this.db.queryMany<RetainedProviderCredentialSecretRow>(
      `SELECT pc.id, pc.provider, pc.storage_backend, pc.secret_version_ref,
              pc.secret_retention_expires_at
       FROM provider_credentials pc
       WHERE pc.source = 'stored'
         AND (
           (pc.status = 'retired'
             AND pc.storage_backend IN ('encrypted_db', 'gcp_secret_manager'))
           OR (
             pc.status IN ('failed_validation', 'deactivated')
             AND pc.storage_backend = 'gcp_secret_manager'
             AND pc.rotated_from_provider_credential_id IS NOT NULL
           )
         )
         AND pc.secret_retention_expires_at IS NOT NULL
         AND (
           pc.secret_retention_expires_at::timestamptz <= clock_timestamp()
           OR NOT EXISTS (
             SELECT 1 FROM provider_credentials child
             WHERE child.rotated_from_provider_credential_id = pc.id
               AND child.status = 'active'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM custody_connections connection
           WHERE connection.provider_credential_id = pc.id
             AND connection.status <> 'deactivated'
         )
       ORDER BY pc.updated_at, pc.id
       LIMIT ?`,
      [limit]
    );
  }

  async cleanupEncryptedDb(params: {
    id: string;
    expectedRetentionExpiresAt: string;
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE provider_credentials pc
         SET encrypted_secret_payload = NULL,
             secret_retention_expires_at = NULL,
             updated_at = sdp_iso_now()
         WHERE pc.id = ?
           AND pc.source = 'stored'
           AND pc.status = 'retired'
           AND pc.storage_backend = 'encrypted_db'
           AND pc.secret_retention_expires_at = ?
           AND (
             pc.secret_retention_expires_at::timestamptz <= clock_timestamp()
             OR NOT EXISTS (
               SELECT 1 FROM provider_credentials child
               WHERE child.rotated_from_provider_credential_id = pc.id
                 AND child.status = 'active'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM custody_connections connection
             WHERE connection.provider_credential_id = pc.id
               AND connection.status <> 'deactivated'
           )`,
        [params.id, params.expectedRetentionExpiresAt]
      )) === 1
    );
  }

  async fenceGcpCleanupCandidate(params: {
    id: string;
    expectedRetentionExpiresAt: string;
  }): Promise<RetainedProviderCredentialSecretRow | null> {
    return this.db.queryOne<RetainedProviderCredentialSecretRow>(
      `UPDATE provider_credentials pc
       SET updated_at = sdp_iso_now()
       WHERE pc.id = ?
         AND pc.source = 'stored'
         AND pc.storage_backend = 'gcp_secret_manager'
         AND (
           pc.status = 'retired'
           OR (
             pc.status IN ('failed_validation', 'deactivated')
             AND pc.rotated_from_provider_credential_id IS NOT NULL
           )
         )
         AND pc.secret_retention_expires_at = ?
         AND (
           pc.secret_retention_expires_at::timestamptz <= clock_timestamp()
           OR NOT EXISTS (
             SELECT 1 FROM provider_credentials child
             WHERE child.rotated_from_provider_credential_id = pc.id
               AND child.status = 'active'
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM custody_connections connection
             WHERE connection.provider_credential_id = pc.id
               AND connection.status <> 'deactivated'
         )
       RETURNING pc.id, pc.provider, pc.storage_backend, pc.secret_version_ref,
                 pc.secret_retention_expires_at`,
      [params.id, params.expectedRetentionExpiresAt]
    );
  }

  async clearGcpRetentionMarker(params: {
    id: string;
    expectedRetentionExpiresAt: string;
    expectedSecretVersionRef: string;
  }): Promise<boolean> {
    return (
      (await this.db.execute(
        `UPDATE provider_credentials pc
         SET secret_retention_expires_at = NULL,
             updated_at = sdp_iso_now()
         WHERE pc.id = ?
           AND pc.source = 'stored'
           AND pc.storage_backend = 'gcp_secret_manager'
           AND (
             pc.status = 'retired'
             OR (
               pc.status IN ('failed_validation', 'deactivated')
               AND pc.rotated_from_provider_credential_id IS NOT NULL
             )
           )
           AND pc.secret_retention_expires_at = ?
           AND pc.secret_version_ref = ?
           AND (
             pc.secret_retention_expires_at::timestamptz <= clock_timestamp()
             OR NOT EXISTS (
               SELECT 1 FROM provider_credentials child
               WHERE child.rotated_from_provider_credential_id = pc.id
                 AND child.status = 'active'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM custody_connections connection
             WHERE connection.provider_credential_id = pc.id
               AND connection.status <> 'deactivated'
           )`,
        [params.id, params.expectedRetentionExpiresAt, params.expectedSecretVersionRef]
      )) === 1
    );
  }
}
