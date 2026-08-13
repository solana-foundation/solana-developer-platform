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
// So a failure to retire is recorded as durable work instead of only logged: the sweeper
// (retireOrphanedActionSecrets) retries it until the version is gone. A log line alone
// left the superseded credential alive in the backend with nothing pointing at it and
// nothing that would ever try again.
export async function destroyActionSecret(
  env: Env,
  stored: StoredCredentialSecret | null | undefined,
  // Recorded with the retirement so an operator can trace an orphan back to its rule.
  context?: { orgId?: string | null; workflowId?: string | null }
): Promise<void> {
  // Nothing to retire: the other backends keep the ciphertext inline, so it goes away
  // with the row. This is the one early return that is genuinely a no-op.
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return;
  }
  // Building the store is inside the try on purpose. A store this process cannot
  // construct is unreachable, not absent — the same distinction reads make — and the
  // queue is exactly what "could not retire it now" means here; the sweeper leaves such
  // rows pending until the deployment can reach the backend again. Bailing out on an
  // unconstructible store skipped the queue along with the destroy, so a broken
  // credential-store config orphaned every rotated and deleted signing key silently,
  // with no record that any of it had happened.
  try {
    await createCredentialSecretStore(env).destroyVersion({
      secretVersionRef: stored.secretVersionRef,
    });
  } catch (error) {
    await recordFailedRetirement(env, stored, context, error);
    return;
  }
  // Destroyed. Discharge the obligation the committing write recorded (rotation and
  // delete queue it in their own transaction, so it is already there). Best effort on
  // purpose: a row left behind costs one sweep that finds the version already gone,
  // whereas failing here would report an error for work that actually happened.
  try {
    await createWorkflowSecretRetirementsRepository(env).deleteRetirementByVersionRef(
      stored.secretVersionRef
    );
  } catch {
    // The sweeper reconciles it.
  }
}

// This insert is the ONLY durable record that an orphaned credential still needs
// destroying — the sweeper reads nothing else — so one attempt is not enough to stake it
// on. Everything that realistically fails it is transient (a dropped connection, a
// deadlock, a statement timeout), and the request's primary write committed moments ago,
// so the database was reachable a heartbeat earlier. A few quick retries turn a blip into
// a queued row instead of a credential that stays readable in the backend forever.
//
// Deliberately short: the caller is a request that has already committed its work and
// cannot be failed by anything here, so the whole budget is a fraction of a second.
const QUEUE_ATTEMPTS = 3;
const QUEUE_BACKOFF_MS = 50;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueRetirement(
  env: Env,
  input: Parameters<
    ReturnType<typeof createWorkflowSecretRetirementsRepository>["recordRetirement"]
  >[0]
): Promise<boolean> {
  for (let attempt = 1; attempt <= QUEUE_ATTEMPTS; attempt++) {
    try {
      // Idempotent on the version ref, so a retry after an ambiguous failure (the insert
      // landed but the response never arrived) updates the row rather than duplicating it.
      await createWorkflowSecretRetirementsRepository(env).recordRetirement(input);
      return true;
    } catch {
      if (attempt === QUEUE_ATTEMPTS) {
        return false;
      }
      await pause(QUEUE_BACKOFF_MS * attempt);
    }
  }
  return false;
}

// Records, BEFORE the row that will reference it is attempted, that a freshly written
// credential currently has no reader. The write that commits the reference cancels this in
// its own transaction, so the two possible outcomes are "the row points at the version"
// and "the version is queued for destruction" — never neither.
//
// Ordering is the whole point. Queued after a failed write, the record is lost exactly
// when the database is what failed; queued before it, the database has already answered
// once and the obligation is durable no matter what the write does next. Best effort in
// turn: if this cannot be written the caller is no worse off than before, so it must not
// fail a create that would otherwise succeed.
export async function queuePendingActionSecret(
  env: Env,
  params: { orgId: string; workflowId: string; stored: StoredCredentialSecret | null }
): Promise<void> {
  const stored = params.stored;
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return;
  }
  const queued = await queueRetirement(env, {
    organizationId: params.orgId,
    workflowId: params.workflowId,
    storageBackend: stored.storageBackend,
    secretRef: stored.secretRef ?? null,
    secretVersionRef: stored.secretVersionRef,
    error: "written for a rule that has not committed yet",
  });
  if (!queued) {
    getLogger().error(
      {
        provider: PROVIDER,
        secretVersionRef: stored.secretVersionRef,
        workflowId: params.workflowId,
        queuedForRetry: false,
        reason: "secret_precommit_queue_failed",
      },
      "workflow_action_secret_orphan_risk"
    );
  }
}

// Queue a failed destroy for the sweeper, and log either way.
//
// This write is a REFRESH, not the record itself. Every caller reaches here with the
// obligation already committed — by the write that orphaned the version (delete, rotation)
// or by the provisional queueing that precedes a write which might not commit (create,
// rotation). All this adds is the reason the destroy failed. So its own failure is not
// "the credential is lost": that is only true if the earlier record ALSO failed to land,
// which takes a database that was unavailable for the whole request — and then there is no
// durable medium to record anything in anyway.
//
// Hence the lookup before claiming nothing will collect it. Reporting `queuedForRetry:
// false` on a version the sweeper is already going to take sends an operator chasing a
// credential that is not actually stranded.
async function recordFailedRetirement(
  env: Env,
  stored: StoredCredentialSecret,
  context: { orgId?: string | null; workflowId?: string | null } | undefined,
  cause: unknown
): Promise<void> {
  const version = stored.secretVersionRef?.split("/").at(-1);
  const reason = cause instanceof Error ? cause.message : String(cause);
  const versionRef = stored.secretVersionRef as string;
  const refreshed = await queueRetirement(env, {
    organizationId: context?.orgId ?? "unknown",
    workflowId: context?.workflowId ?? null,
    storageBackend: stored.storageBackend,
    secretRef: stored.secretRef ?? null,
    secretVersionRef: versionRef,
    error: reason,
  });
  // A failed refresh still leaves the earlier record standing, so ask rather than assume.
  // An unreadable answer counts as not queued: the point of the flag is to summon a human
  // when nothing else will act, and "I could not tell" has to fall on that side.
  const queued =
    refreshed ||
    (await createWorkflowSecretRetirementsRepository(env)
      .hasRetirement(versionRef)
      .catch(() => false));
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
