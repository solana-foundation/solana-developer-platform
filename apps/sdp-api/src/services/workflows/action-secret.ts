// Storage and retrieval of the credential params a workflow action carries (today only
// `send_webhook.secret`, the outbound HMAC key).
//
// Keeping the value in `definition.action.params` meant it was returned by a
// `tokens:read` list endpoint and sat in plaintext in a JSONB column. The read path is
// fixed by redaction; this moves the value itself into the credential secret store, so
// the rule row holds a reference rather than the key.

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
