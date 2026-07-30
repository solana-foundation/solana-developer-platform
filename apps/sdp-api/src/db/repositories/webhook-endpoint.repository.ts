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
  softDeleteEndpoint(params: {
    endpointId: string;
    organizationId: string;
    projectId: string;
  }): Promise<boolean>;
  // Rotation in place: the endpoint id is stable because workflow rules reference it.
  // Shifts current → previous (with a grace expiry) and installs the new handle.
  rotateSecret(params: {
    endpointId: string;
    organizationId: string;
    projectId: string;
    secretStorage: StoredCredentialSecret;
    previousSecretStorage: StoredCredentialSecret | null;
    previousSecretExpiresAt: string | null;
  }): Promise<WebhookEndpointRow | null>;
}
