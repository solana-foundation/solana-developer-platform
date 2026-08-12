// Storage and retrieval of the credential params a workflow action carries (today only
// `send_webhook.secret`, the outbound HMAC key).
//
// Keeping the value in `definition.action.params` meant it was returned by a
// `tokens:read` list endpoint and sat in plaintext in a JSONB column. The read path is
// fixed by redaction; this moves the value itself into the credential secret store, so
// the rule row holds a reference rather than the key.

import { createWorkflowSecretRetirementsRepository } from "@/db/repositories";
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
// Cannot fail the request. Only GCP Secret Manager has external versions to destroy (the
// other backends store the ciphertext inline, and it goes away with the row), and every
// caller reaches this AFTER its primary write has committed — a rotation that already
// replaced the reference, or a delete that already removed the rule. Failing here would
// report an error for work that actually happened.
//
// So a backend failure is recorded as durable work instead of only logged: the sweeper
// (retireOrphanedActionSecrets) retries it until the version is gone. A log line alone
// left the superseded credential alive in the backend with nothing pointing at it and
// nothing that would ever try again.
export async function destroyActionSecret(
  env: Env,
  stored: StoredCredentialSecret | null | undefined,
  // Recorded with the retirement so an operator can trace an orphan back to its rule.
  context?: { orgId?: string | null; workflowId?: string | null }
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
  } catch (error) {
    await recordFailedRetirement(env, stored, context, error);
  }
}

// Queue a failed destroy for the sweeper, and log either way. The insert is itself
// best effort — if it also fails there is nothing left but the log, which is exactly
// where this started, so the log keeps every field needed to find the version by hand.
async function recordFailedRetirement(
  env: Env,
  stored: StoredCredentialSecret,
  context: { orgId?: string | null; workflowId?: string | null } | undefined,
  cause: unknown
): Promise<void> {
  const version = stored.secretVersionRef?.split("/").at(-1);
  const reason = cause instanceof Error ? cause.message : String(cause);
  let queued = true;
  try {
    await createWorkflowSecretRetirementsRepository(env).recordRetirement({
      organizationId: context?.orgId ?? "unknown",
      workflowId: context?.workflowId ?? null,
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
      provider: PROVIDER,
      storageBackend: stored.storageBackend,
      ...(version && /^[1-9][0-9]*$/.test(version)
        ? { providerResourceVersion: Number(version) }
        : {}),
      secretVersionRef: stored.secretVersionRef,
      workflowId: context?.workflowId ?? null,
      error: reason,
      // false → nothing will retry this; it needs a human.
      queuedForRetry: queued,
      reason: "secret_cleanup_failed",
    },
    "workflow_action_secret_orphan_risk"
  );
}

// `secret: null` means the rule carries no signing key at all — an unsigned delivery is
// then what the issuer configured. `ok: false` means the rule HAS one and it could not be
// read, which is a different answer entirely and the caller must not treat it as "no key":
// collapsing the two into null let a transient secret-store failure silently downgrade a
// signed webhook to an unsigned one, and report the execution as succeeded.
export type ReadActionSecretResult = { ok: true; secret: string | null } | { ok: false };

export async function readActionSecret(
  env: Env,
  params: { orgId: string; stored: StoredCredentialSecret | null | undefined }
): Promise<ReadActionSecretResult> {
  if (!params.stored) {
    return { ok: true, secret: null };
  }
  const secretStore = store(env);
  // A rule holding a stored reference on a deployment with no secret store configured:
  // the key exists and is unreachable, not absent.
  if (!secretStore) {
    return { ok: false };
  }
  try {
    const payload = await secretStore.read({ orgId: params.orgId, stored: params.stored });
    const value = payload[PAYLOAD_KEY];
    // A stored reference that yields no usable value is unreadable, not unsigned.
    return typeof value === "string" && value ? { ok: true, secret: value } : { ok: false };
  } catch {
    return { ok: false };
  }
}
