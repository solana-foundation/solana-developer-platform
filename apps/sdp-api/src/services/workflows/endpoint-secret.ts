// Storage and retrieval of a webhook endpoint's signing secret (the registry
// counterpart of action-secret.ts). Secrets are server-generated, written to the
// credential secret store keyed by endpoint id, and the endpoint row holds only the
// StoredCredentialSecret handle — the plaintext is returned exactly once by the
// create/rotate handlers and has no read path afterwards.

import { createWorkflowSecretRetirementsRepository } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import {
  type CredentialSecretStore,
  CredentialSecretStoreError,
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import type { Env } from "@/types/env";

const PROVIDER = "webhook_endpoint";
const PAYLOAD_KEY = "secret";

function store(env: Env): CredentialSecretStore | null {
  try {
    return createCredentialSecretStore(env);
  } catch {
    // Unconfigured deployment. Callers turn this into an explicit refusal rather than
    // silently falling back to plaintext.
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

// 256-bit signing key with the conventional receiver-recognizable prefix.
export function generateWebhookSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `whsec_${base64url(bytes)}`;
}

export type StoreEndpointSecretResult =
  | { ok: true; stored: StoredCredentialSecret }
  | { ok: false; reason: "UNAVAILABLE" };

// `existingSecretRef` makes GCP Secret Manager rotation add a version to the
// endpoint's existing secret instead of minting a new secret per rotation.
export async function storeEndpointSecret(
  env: Env,
  params: { orgId: string; endpointId: string; secret: string; existingSecretRef?: string }
): Promise<StoreEndpointSecretResult> {
  const secretStore = store(env);
  if (!secretStore) {
    return { ok: false, reason: "UNAVAILABLE" };
  }
  try {
    const stored = await secretStore.write({
      orgId: params.orgId,
      provider: PROVIDER,
      providerCredentialId: params.endpointId,
      payload: { [PAYLOAD_KEY]: params.secret },
      existingSecretRef: params.existingSecretRef,
    });
    return { ok: true, stored };
  } catch (error) {
    if (error instanceof CredentialSecretStoreError) {
      return { ok: false, reason: "UNAVAILABLE" };
    }
    throw error;
  }
}

// `secret: null` means there is no handle to read; `ok: false` means a handle exists and
// could not be resolved. Same distinction readActionSecret draws, and for the same reason:
// collapsing the two lets a store outage look like "this key was never configured".
export type ReadEndpointSecretResult = { ok: true; secret: string | null } | { ok: false };

export async function readEndpointSecret(
  env: Env,
  params: { orgId: string; stored: StoredCredentialSecret | null | undefined }
): Promise<ReadEndpointSecretResult> {
  if (!params.stored) {
    return { ok: true, secret: null };
  }
  const secretStore = store(env);
  // A handle on a deployment with no store configured: the key exists and is
  // unreachable, not absent.
  if (!secretStore) {
    return { ok: false };
  }
  try {
    const payload = await secretStore.read({ orgId: params.orgId, stored: params.stored });
    const value = payload[PAYLOAD_KEY];
    // A handle that yields no usable value is unreadable, not unsigned.
    return typeof value === "string" && value ? { ok: true, secret: value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

export type LiveEndpointSecretsResult =
  | { ok: true; secrets: string[] }
  | { ok: false; reason: "SECRET_UNAVAILABLE" | "PREVIOUS_SECRET_UNAVAILABLE" };

// The live signing keys for an endpoint, current first. Callers must refuse to deliver
// when this fails: a managed endpoint never degrades to an unsigned send.
//
// Inside a rotation grace window BOTH keys are live, because the receiver is mid-cutover
// and may still be verifying with the old one. So an unreadable previous key is not a
// detail to skip: dropping its signature is indistinguishable to that receiver from an
// unsigned delivery, and it would reject — turning a transient store failure into a
// permanent 4xx that never retries. Failing here instead keeps the dual-signature
// promise the grace window makes, and the store hiccup gets retried with backoff.
export async function resolveLiveEndpointSecrets(
  env: Env,
  orgId: string,
  endpoint: {
    secret_storage: StoredCredentialSecret;
    previous_secret_storage: StoredCredentialSecret | null;
    previous_secret_expires_at: string | null;
  }
): Promise<LiveEndpointSecretsResult> {
  const current = await readEndpointSecret(env, { orgId, stored: endpoint.secret_storage });
  // `secret_storage` is NOT NULL, so "no handle" cannot happen — either answer means the
  // endpoint's own key is unusable.
  if (!current.ok || !current.secret) {
    return { ok: false, reason: "SECRET_UNAVAILABLE" };
  }
  const secrets = [current.secret];
  if (
    endpoint.previous_secret_storage &&
    endpoint.previous_secret_expires_at &&
    Date.parse(endpoint.previous_secret_expires_at) > Date.now()
  ) {
    const previous = await readEndpointSecret(env, {
      orgId,
      stored: endpoint.previous_secret_storage,
    });
    if (!previous.ok || !previous.secret) {
      return { ok: false, reason: "PREVIOUS_SECRET_UNAVAILABLE" };
    }
    secrets.push(previous.secret);
  }
  return { ok: true, secrets };
}

// Cleanup of a displaced secret version after a rotation (or of the endpoint's own key
// after a delete). Only GCP Secret Manager has external versions to destroy
// (encrypted_db/runtime_env throw UNSUPPORTED_OPERATION and the ciphertext goes away with
// the row), and every caller reaches this AFTER its write has committed, so it cannot fail
// the request.
//
// A backend failure is therefore queued as durable work rather than only logged — the
// same workflow_action_secret_retirements queue the rule-secret path uses, drained by the
// sweeper on the workflow tick. Logging alone left a superseded signing key readable in
// Secret Manager with nothing referencing it and nothing that would ever try again.
export async function destroyEndpointSecretVersion(
  env: Env,
  stored: StoredCredentialSecret | null | undefined,
  // Recorded with the retirement so an operator can trace an orphan back to its endpoint.
  context?: { orgId?: string | null; endpointId?: string | null }
): Promise<void> {
  if (!stored?.secretVersionRef) {
    return;
  }
  const secretStore = store(env);
  if (!secretStore) {
    return;
  }
  try {
    await secretStore.destroyVersion({ secretVersionRef: stored.secretVersionRef });
  } catch (error) {
    if (error instanceof CredentialSecretStoreError && error.code === "UNSUPPORTED_OPERATION") {
      return;
    }
    await recordFailedEndpointRetirement(env, stored, context, error);
  }
}

// Queue the failed destroy, and log either way. The insert is itself best effort: if it
// also fails there is nothing left but the log, so the log carries every field needed to
// find the version by hand.
async function recordFailedEndpointRetirement(
  env: Env,
  stored: StoredCredentialSecret,
  context: { orgId?: string | null; endpointId?: string | null } | undefined,
  cause: unknown
): Promise<void> {
  const reason = cause instanceof Error ? cause.message : String(cause);
  let queued = true;
  try {
    await createWorkflowSecretRetirementsRepository(env).recordRetirement({
      organizationId: context?.orgId ?? "unknown",
      // The queue is shared with rule-secret retirements; this version belongs to an
      // endpoint, so it has no workflow to name.
      workflowId: null,
      storageBackend: stored.storageBackend,
      secretRef: stored.secretRef ?? null,
      secretVersionRef: stored.secretVersionRef as string,
      error: reason,
    });
  } catch {
    queued = false;
  }
  getLogger().error(
    {
      secretVersionRef: stored.secretVersionRef,
      endpointId: context?.endpointId ?? null,
      error: reason,
      queuedForRetry: queued,
    },
    "Failed to destroy displaced webhook endpoint secret version"
  );
}
