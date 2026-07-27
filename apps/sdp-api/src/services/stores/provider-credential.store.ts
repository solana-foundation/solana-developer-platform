import type { DatabaseExecutor } from "@/db";
import { parsePostgresJsonOr } from "@/db/postgres-utils";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";

export type ProviderCredentialStatus =
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
  provider: "privy";
  label: string;
  scope: "organization" | "project";
  scope_key: string;
  display_metadata: unknown;
  status: ProviderCredentialStatus;
  credential_version: number;
  rotated_from_provider_credential_id: string | null;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  created_at: string;
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
  status: CustodyConnectionStatus;
  setup_metadata: unknown;
  last_check_status: string | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
  activated_at: string | null;
  created_at: string;
}

export interface ProjectConnectionState extends CustodyConnectionRow {
  credential_status: ProviderCredentialStatus;
  credential_version: number;
  credential_scope: "organization" | "project";
}

export class ProviderCredentialStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async findReplayByKey(
    organizationId: string,
    idempotencyKey: string
  ): Promise<ProviderCredentialRow | null> {
    return this.db.queryOne<ProviderCredentialRow>(
      `SELECT id, organization_id, project_id, provider, label, scope, scope_key,
              display_metadata, status, credential_version,
              rotated_from_provider_credential_id, idempotency_key,
              idempotency_fingerprint, created_at
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
              c.default_custody_wallet_id, c.status, c.setup_metadata,
              c.last_check_status, c.last_check_at, c.last_check_failure_code,
              c.activated_at, c.created_at,
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
              idempotency_fingerprint, created_at
       FROM provider_credentials
       WHERE id = ?
       ${options.lock ? "FOR UPDATE" : ""}`,
      [id]
    );
  }

  async hasActiveProjectLegacyConfig(organizationId: string, projectId: string): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT id
       FROM custody_configs
       WHERE organization_id = ?
         AND project_id = ?
         AND provider = 'privy'
         AND status = 'active'
       LIMIT 1`,
      [organizationId, projectId]
    );
    return row !== null;
  }

  async insertCredential(params: {
    id: string;
    organizationId: string;
    projectId: string | null;
    label: string;
    scope: "organization" | "project";
    stored: StoredCredentialSecret;
    displayMetadata: Record<string, string>;
    version: number;
    rotatedFromId: string | null;
    idempotencyKey: string;
    idempotencyFingerprint: string;
    createdBy: string;
  }): Promise<ProviderCredentialRow> {
    const scopeKey = params.scope === "organization" ? "__organization__" : params.projectId;
    const row = await this.db.queryOne<ProviderCredentialRow>(
      `INSERT INTO provider_credentials (
         id, organization_id, project_id, provider, label, scope, source,
         storage_backend, secret_ref, secret_version_ref, encrypted_secret_payload,
         display_metadata, status, credential_version,
         rotated_from_provider_credential_id, idempotency_key,
         idempotency_fingerprint, created_by
       ) VALUES (
         ?, ?, ?, 'privy', ?, ?, 'stored',
         ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?
       )
       RETURNING id, organization_id, project_id, provider, label, scope, scope_key,
                 display_metadata, status, credential_version,
                 rotated_from_provider_credential_id, idempotency_key,
                 idempotency_fingerprint, created_at`,
      [
        params.id,
        params.organizationId,
        params.projectId,
        params.label,
        params.scope,
        params.stored.storageBackend,
        params.stored.secretRef ?? null,
        params.stored.secretVersionRef ?? null,
        params.stored.encryptedSecretPayload ?? null,
        JSON.stringify(params.displayMetadata),
        params.version,
        params.rotatedFromId,
        params.idempotencyKey,
        params.idempotencyFingerprint,
        params.createdBy,
      ]
    );

    if (!row || row.scope_key !== scopeKey) {
      throw new Error("Provider credential insert did not return the expected scope");
    }
    return row;
  }

  async insertConnection(params: {
    id: string;
    organizationId: string;
    projectId: string;
    providerCredentialId: string;
    providerCredentialScopeKey: string;
    createdBy: string;
  }): Promise<CustodyConnectionRow> {
    const row = await this.db.queryOne<CustodyConnectionRow>(
      `INSERT INTO custody_connections (
         id, organization_id, project_id, provider, scope,
         provider_credential_id, provider_credential_scope_key,
         status, created_by
       ) VALUES (?, ?, ?, 'privy', 'project', ?, ?, 'pending', ?)
       RETURNING id, organization_id, project_id, provider, scope,
                 provider_credential_id, provider_credential_scope_key,
                 default_custody_wallet_id, status, setup_metadata,
                 last_check_status, last_check_at, last_check_failure_code,
                 activated_at, created_at`,
      [
        params.id,
        params.organizationId,
        params.projectId,
        params.providerCredentialId,
        params.providerCredentialScopeKey,
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
  }): Promise<CustodyConnectionRow | null> {
    return this.db.queryOne<CustodyConnectionRow>(
      `UPDATE custody_connections
       SET provider_credential_id = ?,
           provider_credential_scope_key = ?,
           status = 'pending',
           setup_metadata = '{}'::jsonb,
           last_check_status = NULL,
           last_check_at = NULL,
           last_check_failure_code = NULL,
           updated_at = sdp_iso_now()
       WHERE id = ?
         AND provider_credential_id = ?
         AND status = 'failed'
       RETURNING id, organization_id, project_id, provider, scope,
                 provider_credential_id, provider_credential_scope_key,
                 default_custody_wallet_id, status, setup_metadata,
                 last_check_status, last_check_at, last_check_failure_code,
                 activated_at, created_at`,
      [
        params.providerCredentialId,
        params.providerCredentialScopeKey,
        params.id,
        params.expectedProviderCredentialId,
      ]
    );
  }
}

export function hasPinnedProviderAccountIdentity(value: unknown): boolean {
  return Object.keys(parsePostgresJsonOr<Record<string, unknown>>(value, {})).length > 0;
}
