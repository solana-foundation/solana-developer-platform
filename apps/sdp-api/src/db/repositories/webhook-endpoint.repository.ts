import type { StoredCredentialSecret } from "@/services/credential-secret-store";

export function generateWebhookEndpointId(): string {
  return `webhook_endpoint_${crypto.randomUUID()}`;
}

export type WebhookEndpointStatus = "active" | "disabled";

export interface WebhookEndpointRow {
  id: string;
  organization_id: string;
  project_id: string;
  url: string;
  label: string;
  description: string | null;
  status: WebhookEndpointStatus;
  secret_storage: StoredCredentialSecret;
  previous_secret_storage: StoredCredentialSecret | null;
  previous_secret_expires_at: string | null;
  secret_version: number;
  created_by: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

// The caller supplies the id: the signing secret is written to the secret store
// keyed by endpoint id before the row exists (secret_storage is NOT NULL).
export interface CreateWebhookEndpointInput {
  id: string;
  organizationId: string;
  projectId: string;
  url: string;
  label: string;
  description?: string | null;
  secretStorage: StoredCredentialSecret;
  createdBy?: string | null;
  // The version this request wrote to the secret store, provisionally queued for
  // destruction before the insert was attempted — the only ordering in which a rejected
  // insert cannot strand a live credential nobody references. Committing the row makes the
  // version referenced, so the obligation is cancelled by this same transaction and a
  // rollback keeps it. Normally identical to `secretStorage`.
  clearRetirementFor?: StoredCredentialSecret | null;
}

// A write that drops a secret version out of the row returns the displaced handles, read
// under the same lock that performed the write. The caller attempts the backend destroy
// once the transaction has committed; each handle is already queued for retirement, so a
// failed or never-attempted destroy degrades to the sweeper rather than to a leak.
export interface WebhookEndpointSecretWriteResult {
  row: WebhookEndpointRow;
  retired: StoredCredentialSecret[];
}

export interface WebhookEndpointsRepository {
  createEndpoint(input: CreateWebhookEndpointInput): Promise<WebhookEndpointRow | null>;
  getEndpointById(params: {
    endpointId: string;
    organizationId: string;
    projectId: string;
    // The engine and redeliver need to distinguish deleted from never-existed.
    includeDeleted?: boolean;
  }): Promise<WebhookEndpointRow | null>;
  listEndpoints(params: {
    organizationId: string;
    projectId: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: WebhookEndpointRow[]; total: number }>;
  updateEndpoint(params: {
    endpointId: string;
    organizationId: string;
    projectId: string;
    label?: string;
    description?: string | null;
    status?: WebhookEndpointStatus;
  }): Promise<WebhookEndpointRow | null>;
  // Soft delete (keeps the delivery log; hard DELETE would cascade it away).
  // Both of the endpoint's signing keys are orphaned the moment this commits, so their
  // retirement is recorded by the same transaction, from the row read under lock.
  // `deleted` is false when the endpoint does not exist or was already deleted; the retry
  // of a delete whose cleanup died still reports the keys it left behind.
  softDeleteEndpoint(params: {
    endpointId: string;
    organizationId: string;
    projectId: string;
  }): Promise<{ deleted: boolean; retired: StoredCredentialSecret[] }>;
  // Rotation in place: the endpoint id is stable because workflow rules reference it.
  // Shifts current → previous (with a grace expiry) and installs the new handle.
  //
  // What becomes `previous` is resolved from the row under lock rather than passed in: the
  // caller's view predates this transaction, so a rotation that committed in between would
  // have it write back a version that is already retired, leaving the live endpoint signing
  // with a destroyed key. A null `previousSecretExpiresAt` means no grace — the displaced
  // current key is retired immediately instead of being kept live.
  rotateSecret(params: {
    endpointId: string;
    organizationId: string;
    projectId: string;
    secretStorage: StoredCredentialSecret;
    previousSecretExpiresAt: string | null;
  }): Promise<WebhookEndpointSecretWriteResult | null>;
}
