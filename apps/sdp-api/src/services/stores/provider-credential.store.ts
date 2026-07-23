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

export interface CredentialReplay {
  providerCredential: ProviderCredentialRow;
  custodyConnections: CustodyConnectionRow[];
}

type ReplayQueryRow = {
  credential_id: string;
  credential_organization_id: string;
  credential_project_id: string | null;
  credential_provider: "privy";
  credential_label: string;
  credential_scope: "organization" | "project";
  credential_scope_key: string;
  credential_display_metadata: unknown;
  credential_status: ProviderCredentialStatus;
  credential_version: number;
  credential_rotated_from_id: string | null;
  credential_idempotency_key: string | null;
  credential_idempotency_fingerprint: string | null;
  credential_created_at: string;
  connection_id: string | null;
  connection_organization_id: string | null;
  connection_project_id: string | null;
  connection_provider: "privy" | null;
  connection_scope: "project" | null;
  connection_provider_credential_id: string | null;
  connection_provider_credential_scope_key: string | null;
  connection_default_wallet_id: string | null;
  connection_status: CustodyConnectionStatus | null;
  connection_setup_metadata: unknown;
  connection_last_check_status: string | null;
  connection_last_check_at: string | null;
  connection_last_check_failure_code: string | null;
  connection_activated_at: string | null;
  connection_created_at: string | null;
};

export class ProviderCredentialStore {
  constructor(private readonly db: DatabaseExecutor) {}

  async findReplayByKey(
    organizationId: string,
    projectId: string,
    idempotencyKey: string
  ): Promise<CredentialReplay | null> {
    const rows = await this.db.queryMany<ReplayQueryRow>(
      `WITH RECURSIVE
       attempt AS (
         SELECT id, organization_id, project_id, provider, label, scope, scope_key,
                display_metadata, status, credential_version,
                rotated_from_provider_credential_id, idempotency_key,
                idempotency_fingerprint, created_at
         FROM provider_credentials
         WHERE organization_id = ? AND idempotency_key = ?
       ),
       ancestors AS (
         SELECT id, rotated_from_provider_credential_id
         FROM attempt
         UNION ALL
         SELECT parent.id, parent.rotated_from_provider_credential_id
         FROM provider_credentials parent
         JOIN ancestors child
           ON parent.id = child.rotated_from_provider_credential_id
         WHERE parent.organization_id = ?
       ),
       lineage_root AS (
         SELECT id
         FROM ancestors
         WHERE rotated_from_provider_credential_id IS NULL
       ),
       lineage AS (
         SELECT id
         FROM lineage_root
         UNION ALL
         SELECT child.id
         FROM provider_credentials child
         JOIN lineage parent
           ON child.rotated_from_provider_credential_id = parent.id
         WHERE child.organization_id = ?
       ),
       matching_connections AS (
         SELECT c.id, c.organization_id, c.project_id, c.provider, c.scope,
                c.provider_credential_id, c.provider_credential_scope_key,
                c.default_custody_wallet_id, c.status, c.setup_metadata,
                c.last_check_status, c.last_check_at, c.last_check_failure_code,
                c.activated_at, c.created_at
         FROM custody_connections c
         WHERE c.organization_id = ?
           AND c.project_id = ?
           AND c.provider_credential_id IN (SELECT id FROM lineage)
       )
       SELECT
         a.id AS credential_id,
         a.organization_id AS credential_organization_id,
         a.project_id AS credential_project_id,
         a.provider AS credential_provider,
         a.label AS credential_label,
         a.scope AS credential_scope,
         a.scope_key AS credential_scope_key,
         a.display_metadata AS credential_display_metadata,
         a.status AS credential_status,
         a.credential_version AS credential_version,
         a.rotated_from_provider_credential_id AS credential_rotated_from_id,
         a.idempotency_key AS credential_idempotency_key,
         a.idempotency_fingerprint AS credential_idempotency_fingerprint,
         a.created_at AS credential_created_at,
         c.id AS connection_id,
         c.organization_id AS connection_organization_id,
         c.project_id AS connection_project_id,
         c.provider AS connection_provider,
         c.scope AS connection_scope,
         c.provider_credential_id AS connection_provider_credential_id,
         c.provider_credential_scope_key AS connection_provider_credential_scope_key,
         c.default_custody_wallet_id AS connection_default_wallet_id,
         c.status AS connection_status,
         c.setup_metadata AS connection_setup_metadata,
         c.last_check_status AS connection_last_check_status,
         c.last_check_at AS connection_last_check_at,
         c.last_check_failure_code AS connection_last_check_failure_code,
         c.activated_at AS connection_activated_at,
         c.created_at AS connection_created_at
       FROM attempt a
       LEFT JOIN matching_connections c ON TRUE
       ORDER BY c.created_at, c.id`,
      [organizationId, idempotencyKey, organizationId, organizationId, organizationId, projectId]
    );

    const first = rows[0];
    if (!first) {
      return null;
    }

    const providerCredential: ProviderCredentialRow = {
      id: first.credential_id,
      organization_id: first.credential_organization_id,
      project_id: first.credential_project_id,
      provider: first.credential_provider,
      label: first.credential_label,
      scope: first.credential_scope,
      scope_key: first.credential_scope_key,
      display_metadata: first.credential_display_metadata,
      status: first.credential_status,
      credential_version: first.credential_version,
      rotated_from_provider_credential_id: first.credential_rotated_from_id,
      idempotency_key: first.credential_idempotency_key,
      idempotency_fingerprint: first.credential_idempotency_fingerprint,
      created_at: first.credential_created_at,
    };

    const custodyConnections = rows.flatMap((row): CustodyConnectionRow[] => {
      if (
        !row.connection_id ||
        !row.connection_organization_id ||
        !row.connection_project_id ||
        !row.connection_provider ||
        !row.connection_scope ||
        !row.connection_provider_credential_id ||
        !row.connection_provider_credential_scope_key ||
        !row.connection_status ||
        !row.connection_created_at
      ) {
        return [];
      }

      return [
        {
          id: row.connection_id,
          organization_id: row.connection_organization_id,
          project_id: row.connection_project_id,
          provider: row.connection_provider,
          scope: row.connection_scope,
          provider_credential_id: row.connection_provider_credential_id,
          provider_credential_scope_key: row.connection_provider_credential_scope_key,
          default_custody_wallet_id: row.connection_default_wallet_id,
          status: row.connection_status,
          setup_metadata: row.connection_setup_metadata,
          last_check_status: row.connection_last_check_status,
          last_check_at: row.connection_last_check_at,
          last_check_failure_code: row.connection_last_check_failure_code,
          activated_at: row.connection_activated_at,
          created_at: row.connection_created_at,
        },
      ];
    });

    return { providerCredential, custodyConnections };
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
