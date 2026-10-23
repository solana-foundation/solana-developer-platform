import type { DatabaseExecutor } from "@/db/client";
import { internalError } from "@/lib/errors";

export interface FireblocksCsrScope {
  organizationId: string;
  projectId: string;
}
export interface FireblocksCsrPublicRow {
  id: string;
  csr_pem: string;
  expires_at: string;
}
interface FireblocksCsrKeyRow {
  id: string;
  encrypted_private_key: string;
}

/** Tenant/project-scoped CSR staging; callers retain the surrounding transaction. */
export class FireblocksCsrRepository {
  constructor(private readonly db: DatabaseExecutor) {}

  getPending(scope: FireblocksCsrScope): Promise<FireblocksCsrPublicRow | null> {
    return this.db.queryOne<FireblocksCsrPublicRow>(
      `SELECT id, csr_pem, expires_at FROM fireblocks_csr_requests
       WHERE organization_id = ? AND project_id = ? AND status = 'active' AND encrypted_private_key IS NOT NULL
         AND claim_fingerprint IS NULL AND expires_at > sdp_iso_now()
       ORDER BY created_at DESC LIMIT 1`,
      [scope.organizationId, scope.projectId]
    );
  }

  getByIdempotencyKey(
    scope: FireblocksCsrScope,
    key: string
  ): Promise<FireblocksCsrPublicRow | null> {
    return this.db.queryOne<FireblocksCsrPublicRow>(
      `SELECT id, csr_pem, expires_at FROM fireblocks_csr_requests
       WHERE organization_id = ? AND project_id = ? AND idempotency_key = ?`,
      [scope.organizationId, scope.projectId, key]
    );
  }

  async countPending(scope: FireblocksCsrScope): Promise<number> {
    const row = await this.db.queryOne<{ count: string }>(
      `SELECT count(*)::text AS count FROM fireblocks_csr_requests
       WHERE organization_id = ? AND project_id = ? AND status = 'active' AND encrypted_private_key IS NOT NULL
         AND expires_at > sdp_iso_now()`,
      [scope.organizationId, scope.projectId]
    );
    if (!row) throw internalError("Could not count pending Fireblocks registrations");
    return Number(row.count);
  }

  create(
    scope: FireblocksCsrScope,
    input: {
      id: string;
      idempotencyKey: string;
      csrPem: string;
      encryptedKey: string;
      userId: string;
    }
  ): Promise<FireblocksCsrPublicRow | null> {
    return this.db.queryOne<FireblocksCsrPublicRow>(
      `INSERT INTO fireblocks_csr_requests
       (id, organization_id, project_id, idempotency_key, csr_pem, encrypted_private_key, created_by, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, to_char(timezone('UTC', now()) + interval '7 days', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
       RETURNING id, csr_pem, expires_at`,
      [
        input.id,
        scope.organizationId,
        scope.projectId,
        input.idempotencyKey,
        input.csrPem,
        input.encryptedKey,
        input.userId,
      ]
    );
  }

  claimForRegistration(
    scope: FireblocksCsrScope,
    id: string,
    fingerprint: string
  ): Promise<FireblocksCsrKeyRow | null> {
    return this.db.queryOne<FireblocksCsrKeyRow>(
      `UPDATE fireblocks_csr_requests SET claim_fingerprint = ?
       WHERE id = ? AND organization_id = ? AND project_id = ?
         AND status = 'active' AND encrypted_private_key IS NOT NULL AND expires_at > sdp_iso_now()
         AND (claim_fingerprint IS NULL OR claim_fingerprint = ?)
       RETURNING id, encrypted_private_key`,
      [fingerprint, id, scope.organizationId, scope.projectId, fingerprint]
    );
  }

  getForDiscovery(scope: FireblocksCsrScope, id: string): Promise<FireblocksCsrKeyRow | null> {
    return this.db.queryOne<FireblocksCsrKeyRow>(
      `SELECT id, encrypted_private_key FROM fireblocks_csr_requests
       WHERE id = ? AND organization_id = ? AND project_id = ?
         AND status = 'active' AND encrypted_private_key IS NOT NULL AND claim_fingerprint IS NULL
         AND expires_at > sdp_iso_now()`,
      [id, scope.organizationId, scope.projectId]
    );
  }

  async retire(scope: FireblocksCsrScope, id: string, credentialId: string): Promise<void> {
    await this.db.execute(
      `UPDATE fireblocks_csr_requests SET status = 'archived', encrypted_private_key = NULL, consumed_at = sdp_iso_now()
       WHERE id = ? AND organization_id = ? AND project_id = ?
         AND EXISTS (SELECT 1 FROM provider_credentials WHERE id = ? AND organization_id = ?
           AND (encrypted_secret_payload IS NOT NULL OR secret_version_ref IS NOT NULL))`,
      [id, scope.organizationId, scope.projectId, credentialId, scope.organizationId]
    );
  }

  /** System worker only: bounded expiration cleanup across tenants. */
  async eraseExpired(): Promise<void> {
    await this.db.execute(`UPDATE fireblocks_csr_requests SET status = 'archived', encrypted_private_key = NULL
      WHERE id IN (SELECT id FROM fireblocks_csr_requests
        WHERE encrypted_private_key IS NOT NULL AND expires_at <= sdp_iso_now()
        ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED)`);
  }
}
