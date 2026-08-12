// Storage and retrieval of the credential params a workflow action carries (today only
// `send_webhook.secret`, the outbound HMAC key).
//
// Keeping the value in `definition.action.params` meant it was returned by a
// `tokens:read` list endpoint and sat in plaintext in a JSONB column. The read path is
// fixed by redaction; this moves the value itself into the credential secret store, so
// the rule row holds a reference rather than the key.

import { getLogger } from "@/runtime/logger";
import {
  type CredentialSecretStore,
  CredentialSecretStoreError,
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import type { Env } from "@/types/env";

const PROVIDER = "workflow_action";
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

export type StoreSecretResult =
  | { ok: true; stored: StoredCredentialSecret }
  | { ok: false; reason: "UNAVAILABLE" };

export async function storeActionSecret(
  env: Env,
  params: { orgId: string; workflowId: string; secret: string }
): Promise<StoreSecretResult> {
  const secretStore = store(env);
  if (!secretStore) {
    return { ok: false, reason: "UNAVAILABLE" };
  }
  try {
    const stored = await secretStore.write({
      orgId: params.orgId,
      provider: PROVIDER,
      providerCredentialId: params.workflowId,
      payload: { [PAYLOAD_KEY]: params.secret },
    });
    return { ok: true, stored };
  } catch (error) {
    if (error instanceof CredentialSecretStoreError) {
      return { ok: false, reason: "UNAVAILABLE" };
    }
    throw error;
  }
}

// Retires a secret nothing points at any more: the version superseded by a rotation, the
// rule's key after a delete, or one written for a row that then failed to commit. Without
// this the value stays readable in the backend indefinitely.
//
// Best effort by design. Only GCP Secret Manager has external versions to destroy (the
// other backends store the ciphertext inline, and it goes away with the row), and a
// cleanup failure must not fail a request whose primary write already succeeded — the
// orphaned version is logged instead so it can be reaped out of band.
export async function destroyActionSecret(
  env: Env,
  stored: StoredCredentialSecret | null | undefined
): Promise<void> {
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return;
  }
  const secretStore = store(env);
  if (!secretStore) {
    return;
  }
  try {
    await secretStore.destroyVersion({ secretVersionRef: stored.secretVersionRef });
  } catch {
    const version = stored.secretVersionRef.split("/").at(-1);
    getLogger().error(
      {
        provider: PROVIDER,
        storageBackend: stored.storageBackend,
        ...(version && /^[1-9][0-9]*$/.test(version)
          ? { providerResourceVersion: Number(version) }
          : {}),
        reason: "secret_cleanup_failed",
      },
      "workflow_action_secret_orphan_risk"
    );
  }
}

// Returns null when there is no stored secret, or when it can't be read — the webhook
// action then sends unsigned rather than failing the delivery outright, and says so in
// the execution result.
export async function readActionSecret(
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
