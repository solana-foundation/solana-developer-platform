// Storage and retrieval of a webhook endpoint's signing secret (the registry
// counterpart of action-secret.ts). Secrets are server-generated, written to the
// credential secret store keyed by endpoint id, and the endpoint row holds only the
// StoredCredentialSecret handle — the plaintext is returned exactly once by the
// create/rotate handlers and has no read path afterwards.

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

// Returns null when the handle can't be resolved. Unlike the legacy inline-url path,
// managed endpoints never fall back to sending unsigned — the caller fails transient.
export async function readEndpointSecret(
  env: Env,
  params: { orgId: string; stored: StoredCredentialSecret | null | undefined }
): Promise<string | null> {
  if (!params.stored) {
    return null;
  }
  const secretStore = store(env);
  if (!secretStore) {
    return null;
  }
  try {
    const payload = await secretStore.read({ orgId: params.orgId, stored: params.stored });
    const value = payload[PAYLOAD_KEY];
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

// The live signing keys for an endpoint, current first; null when the current key
// can't be read (the caller fails transient — a managed endpoint never sends
// unsigned). The previous key only signs until its rotation grace expiry; a failed
// previous-key read is ignored since the current key still signs.
export async function resolveLiveEndpointSecrets(
  env: Env,
  orgId: string,
  endpoint: {
    secret_storage: StoredCredentialSecret;
    previous_secret_storage: StoredCredentialSecret | null;
    previous_secret_expires_at: string | null;
  }
): Promise<string[] | null> {
  const current = await readEndpointSecret(env, { orgId, stored: endpoint.secret_storage });
  if (!current) {
    return null;
  }
  const secrets = [current];
  if (
    endpoint.previous_secret_storage &&
    endpoint.previous_secret_expires_at &&
    Date.parse(endpoint.previous_secret_expires_at) > Date.now()
  ) {
    const previous = await readEndpointSecret(env, {
      orgId,
      stored: endpoint.previous_secret_storage,
    });
    if (previous) {
      secrets.push(previous);
    }
  }
  return secrets;
}

// Best-effort cleanup of a displaced secret version after rotation. Only GCP Secret
// Manager supports destroying versions (encrypted_db/runtime_env throw
// UNSUPPORTED_OPERATION); failures never block the rotation that already happened.
export async function destroyEndpointSecretVersion(
  env: Env,
  stored: StoredCredentialSecret | null | undefined
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
    getLogger().error({ error }, "Failed to destroy displaced webhook endpoint secret version");
  }
}
