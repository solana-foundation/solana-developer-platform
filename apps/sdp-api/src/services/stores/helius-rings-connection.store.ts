import type { DatabaseExecutor } from "@/db";
import type { StoredCredentialSecret } from "@/services/credential-secret-store";

export type HeliusRingsConnectionStatus = "active" | "failed" | "deactivated";

export interface HeliusRingsConnectionRow {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  provider_credential_id: string;
  provider_credential_scope_key: string;
  network: "devnet";
  status: HeliusRingsConnectionStatus;
  is_default: boolean;
  allow_insecure_http: boolean;
  display_metadata: unknown;
  last_check_status: string | null;
  last_check_at: string | null;
  last_check_failure_code: string | null;
  activated_at: string | null;
  deactivated_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ResolvableHeliusRingsConnectionRow extends HeliusRingsConnectionRow {
  credential_storage_backend: StoredCredentialSecret["storageBackend"];
  credential_secret_ref: string | null;
  credential_secret_version_ref: string | null;
  credential_encrypted_secret_payload: string | null;
}

const SELECT_COLUMNS = `
  c.id, c.organization_id, c.project_id, c.name,
  c.provider_credential_id, c.provider_credential_scope_key,
  c.network, c.status, c.is_default, c.allow_insecure_http,
  c.display_metadata, c.last_check_status, c.last_check_at,
  c.last_check_failure_code, c.activated_at, c.deactivated_at,
  c.created_at, c.updated_at`;

export class HeliusRingsConnectionStore {
  constructor(private readonly db: DatabaseExecutor) {}

  list(organizationId: string, projectId: string): Promise<HeliusRingsConnectionRow[]> {
    return this.db.queryMany<HeliusRingsConnectionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM helius_rings_connections c
        WHERE c.organization_id = ? AND c.project_id = ?
        ORDER BY c.is_default DESC, c.created_at DESC, c.id DESC`,
      [organizationId, projectId]
    );
  }

  findDefault(
    organizationId: string,
    projectId: string
  ): Promise<ResolvableHeliusRingsConnectionRow | null> {
    return this.findResolvable(organizationId, projectId, undefined);
  }

  findById(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<ResolvableHeliusRingsConnectionRow | null> {
    return this.findResolvable(organizationId, projectId, connectionId);
  }

  private findResolvable(
    organizationId: string,
    projectId: string,
    connectionId: string | undefined
  ): Promise<ResolvableHeliusRingsConnectionRow | null> {
    return this.db.queryOne<ResolvableHeliusRingsConnectionRow>(
      `SELECT ${SELECT_COLUMNS},
              pc.storage_backend AS credential_storage_backend,
              pc.secret_ref AS credential_secret_ref,
              pc.secret_version_ref AS credential_secret_version_ref,
              pc.encrypted_secret_payload AS credential_encrypted_secret_payload
         FROM helius_rings_connections c
         JOIN provider_credentials pc ON pc.id = c.provider_credential_id
        WHERE c.organization_id = ?
          AND c.project_id = ?
          AND c.status = 'active'
          AND pc.status = 'active'
          ${connectionId ? "AND c.id = ?" : "AND c.is_default = TRUE"}
        LIMIT 1`,
      connectionId ? [organizationId, projectId, connectionId] : [organizationId, projectId]
    );
  }

  async insert(input: {
    id: string;
    organizationId: string;
    projectId: string;
    name: string;
    providerCredentialId: string;
    providerCredentialScopeKey: string;
    allowInsecureHttp: boolean;
    displayMetadata: Record<string, string | null>;
    makeDefault: boolean;
    createdBy: string;
  }): Promise<HeliusRingsConnectionRow> {
    const row = await this.db.queryOne<HeliusRingsConnectionRow>(
      `INSERT INTO helius_rings_connections (
         id, organization_id, project_id, name, provider_credential_id,
         provider_credential_scope_key, network, status, is_default,
         allow_insecure_http, display_metadata, activated_at, created_by
       ) VALUES (?, ?, ?, ?, ?, ?, 'devnet', 'active', ?, ?, ?::jsonb, sdp_iso_now(), ?)
       RETURNING *`,
      [
        input.id,
        input.organizationId,
        input.projectId,
        input.name,
        input.providerCredentialId,
        input.providerCredentialScopeKey,
        input.makeDefault,
        input.allowInsecureHttp,
        JSON.stringify(input.displayMetadata),
        input.createdBy,
      ]
    );
    if (!row) throw new Error("Helius Rings connection insert returned no row");
    return row;
  }

  async countActive(organizationId: string, projectId: string): Promise<number> {
    const row = await this.db.queryOne<{ total: number | string }>(
      `SELECT COUNT(*) AS total
         FROM helius_rings_connections
        WHERE organization_id = ? AND project_id = ? AND status = 'active'`,
      [organizationId, projectId]
    );
    return Number(row?.total ?? 0);
  }

  async hasUnsettledOperations(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<boolean> {
    const row = await this.db.queryOne<{ id: string }>(
      `SELECT id
         FROM helius_rings_operations
        WHERE organization_id = ? AND project_id = ? AND rings_connection_id = ?
          AND state NOT IN ('completed', 'voided')
        LIMIT 1`,
      [organizationId, projectId, connectionId]
    );
    return row !== null;
  }

  /** Serializes deactivation with the operation repository's SHARE pin lock. */
  lockActiveNonDefault(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<HeliusRingsConnectionRow | null> {
    return this.db.queryOne<HeliusRingsConnectionRow>(
      `SELECT ${SELECT_COLUMNS}
         FROM helius_rings_connections c
        WHERE c.id = ? AND c.organization_id = ? AND c.project_id = ?
          AND c.status = 'active' AND c.is_default = FALSE
        FOR UPDATE`,
      [connectionId, organizationId, projectId]
    );
  }

  async makeDefault(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<HeliusRingsConnectionRow | null> {
    const target = await this.db.queryOne<{ id: string }>(
      `SELECT id
         FROM helius_rings_connections
        WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'
        FOR UPDATE`,
      [connectionId, organizationId, projectId]
    );
    if (!target) return null;

    await this.db.execute(
      `UPDATE helius_rings_connections
          SET is_default = FALSE, updated_at = sdp_iso_now()
        WHERE organization_id = ? AND project_id = ? AND is_default = TRUE`,
      [organizationId, projectId]
    );
    return this.db.queryOne<HeliusRingsConnectionRow>(
      `UPDATE helius_rings_connections
          SET is_default = TRUE, updated_at = sdp_iso_now()
        WHERE id = ? AND organization_id = ? AND project_id = ? AND status = 'active'
        RETURNING *`,
      [connectionId, organizationId, projectId]
    );
  }

  async deactivate(
    organizationId: string,
    projectId: string,
    connectionId: string
  ): Promise<HeliusRingsConnectionRow | null> {
    return this.db.queryOne<HeliusRingsConnectionRow>(
      `UPDATE helius_rings_connections
          SET status = 'deactivated', is_default = FALSE,
              deactivated_at = sdp_iso_now(), updated_at = sdp_iso_now()
        WHERE id = ? AND organization_id = ? AND project_id = ?
          AND status <> 'deactivated' AND is_default = FALSE
        RETURNING *`,
      [connectionId, organizationId, projectId]
    );
  }
}
