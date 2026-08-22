// Durable retirement of credential-secret versions, for every consumer of the
// credential secret store.
//
// Only GCP Secret Manager has external versions to destroy — the other
// backends keep ciphertext inline, and it dies with the row. A version written
// there outlives its request, so "clean up on failure" cannot be a catch block
// alone: the process can die between the write and the compensating destroy
// (worker loss), and the destroy itself can fail (timeout, outage). The
// workflow action-secret path (`services/workflows/action-secret.ts`) solved
// this with a durable obligation queue plus a sweeper, and this module is the
// same discipline for the OTHER consumers — BYOK RPC connections and Privy
// provider credentials — over the same queue table and the same sweeper
// (`services/jobs/retire-workflow-secrets.ts`).
//
// The queue table is `workflow_action_secret_retirements` — a historical name;
// it carries no workflow-specific constraint (`workflow_id` is a nullable
// trace column, there are no foreign keys) and the sweeper resolves the store
// per row from `storage_backend`, so rows recorded here are collected by the
// existing cron with no changes.
//
// The ordering rule, copied from the workflow path because it is the only one
// that closes worker loss: record the obligation AFTER the backend write but
// BEFORE the database row that will reference the version; the transaction
// that commits the reference clears the obligation atomically. The two
// possible outcomes are "the row points at the version" and "the version is
// queued for destruction" — never neither.

import type { AppDb } from "@/db";
import { createWorkflowSecretRetirementsRepository } from "@/db/repositories";
import {
  deleteWorkflowSecretRetirement,
  insertWorkflowSecretRetirement,
} from "@/db/repositories/workflow-secret-retirement.repository.postgres";
import { serviceUnavailable } from "@/lib/errors";
import { getLogger } from "@/runtime/logger";
import {
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import type { Env } from "@/types/env";

/** Where the version came from, for logs and the queue's trace columns. */
export interface SecretRetirementContext {
  /** Log label, e.g. "rpc_connection" or "privy". */
  provider: string;
  orgId: string | null;
  /**
   * The row the version belonged to (connection or credential id). Recorded in
   * the queue's `workflow_id` column — a historical name; the column is a
   * nullable trace with no foreign key.
   */
  sourceId: string | null;
}

/** A version exists to destroy only for GCP-backed secrets with a version ref. */
function destroyableVersionRef(stored: StoredCredentialSecret | null | undefined): string | null {
  if (stored?.storageBackend !== "gcp_secret_manager" || !stored.secretVersionRef) {
    return null;
  }
  return stored.secretVersionRef;
}

// This insert is the ONLY durable record that an orphaned credential still
// needs destroying, so one attempt is not enough to stake it on. Everything
// that realistically fails it is transient, and the caller's own database
// write succeeded moments before or is about to run — so the budget is a
// fraction of a second of quick retries, never a failed request.
const QUEUE_ATTEMPTS = 3;
const QUEUE_BACKOFF_MS = 50;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueRetirement(
  env: Env,
  context: SecretRetirementContext,
  stored: StoredCredentialSecret,
  reason: string
): Promise<boolean> {
  const secretVersionRef = destroyableVersionRef(stored);
  if (!secretVersionRef) {
    return true;
  }
  for (let attempt = 1; attempt <= QUEUE_ATTEMPTS; attempt++) {
    try {
      // Idempotent on the version ref, so a retry after an ambiguous failure
      // updates the row rather than duplicating it.
      await createWorkflowSecretRetirementsRepository(env).recordRetirement({
        organizationId: context.orgId ?? "unknown",
        workflowId: context.sourceId,
        storageBackend: stored.storageBackend,
        secretRef: stored.secretRef ?? null,
        secretVersionRef,
        error: reason,
      });
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

// Deliberately excludes the secret ref and the raw backend error: log lines
// must not carry secret resource names or unredacted provider messages (the
// provider-credential tests pin this). The queue row's `last_error` column is
// where the raw reason lives.
function logOrphanRisk(
  context: SecretRetirementContext,
  stored: StoredCredentialSecret,
  params: { reason: string; queuedForRetry: boolean }
): void {
  const version = stored.secretVersionRef?.split("/").at(-1);
  getLogger().error(
    {
      provider: context.provider,
      storageBackend: stored.storageBackend,
      ...(version && /^[1-9][0-9]*$/.test(version)
        ? { providerResourceVersion: Number(version) }
        : {}),
      sourceId: context.sourceId,
      // false → nothing will retry this; it needs a human.
      queuedForRetry: params.queuedForRetry,
      reason: params.reason,
    },
    "credential_secret_orphan_risk"
  );
}

/**
 * Record, BEFORE the row that will reference it is attempted, that a freshly
 * written version currently has no reader. The transaction that commits the
 * reference cancels this via `clearQueuedSecretVersion`; a transaction that
 * fails — or a process that dies before running one — leaves the obligation
 * standing for the sweeper.
 *
 * Fails closed: this record is the ONLY thing that makes worker loss safe, so
 * if it cannot be written the create must not proceed into the unprotected
 * window. The version is taken back instead and the request refused — the
 * caller retries against a clean slate, and no credential is ever live with
 * nothing on record that it exists.
 *
 * @throws AppError SERVICE_UNAVAILABLE when the obligation cannot be recorded.
 */
export async function queuePendingSecretVersion(
  env: Env,
  stored: StoredCredentialSecret | null | undefined,
  context: SecretRetirementContext
): Promise<void> {
  if (!destroyableVersionRef(stored)) {
    return;
  }
  const queued = await queueRetirement(
    env,
    context,
    stored as StoredCredentialSecret,
    "written for a row that has not committed yet"
  );
  if (queued) {
    return;
  }
  // Destroy now, while this process still remembers the version. If even that
  // fails, `destroySecretVersion` re-attempts the queue and, as the last
  // resort, logs the orphan risk with queuedForRetry:false — loud, not silent.
  await destroySecretVersion(env, stored, context);
  throw serviceUnavailable(
    "Credential cleanup could not be durably recorded; nothing was created — retry the request"
  );
}

/**
 * Cancel the provisional obligation recorded by `queuePendingSecretVersion`,
 * inside the transaction that commits the row referencing the version — the
 * only ordering in which a rejected write cannot leave a credential nobody
 * knows about.
 */
export async function clearQueuedSecretVersion(
  exec: Pick<AppDb, "prepare">,
  stored: StoredCredentialSecret | null | undefined
): Promise<void> {
  const secretVersionRef = destroyableVersionRef(stored);
  if (!secretVersionRef) {
    return;
  }
  await deleteWorkflowSecretRetirement(exec, secretVersionRef);
}

/**
 * Record, inside the caller's transaction, that a version this write orphans
 * still needs destroying — the pattern for a delete or deactivation whose
 * commit is exactly what makes the version garbage. The caller still attempts
 * the destroy immediately after commit (`destroySecretVersion`), which clears
 * this row on success.
 */
export async function queueOrphanedSecretVersion(
  exec: Pick<AppDb, "prepare">,
  context: SecretRetirementContext,
  stored: StoredCredentialSecret | null | undefined,
  reason: string
): Promise<void> {
  const secretVersionRef = destroyableVersionRef(stored);
  if (!secretVersionRef) {
    return;
  }
  await insertWorkflowSecretRetirement(exec, {
    organizationId: context.orgId ?? "unknown",
    workflowId: context.sourceId,
    storageBackend: stored?.storageBackend as string,
    secretRef: stored?.secretRef ?? null,
    secretVersionRef,
    error: reason,
  });
}

/**
 * Destroy a version and discharge its queued obligation; on any failure —
 * including a store this process cannot construct — record durable work for
 * the sweeper instead of only logging. Never throws: every caller reaches
 * this after its primary write already committed (or failed for its own
 * reasons), and failing the request for cleanup would report an error for
 * work that actually happened.
 */
export async function destroySecretVersion(
  env: Env,
  stored: StoredCredentialSecret | null | undefined,
  context: SecretRetirementContext
): Promise<void> {
  const secretVersionRef = destroyableVersionRef(stored);
  if (!secretVersionRef) {
    return;
  }
  // Building the store is inside the try on purpose: a store this process
  // cannot construct is unreachable, not absent, and the queue is exactly what
  // "could not retire it now" means here.
  try {
    await createCredentialSecretStore(env, "gcp_secret_manager").destroyVersion({
      secretVersionRef,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const queued = await queueRetirement(env, context, stored as StoredCredentialSecret, reason);
    // A failed refresh may still leave an earlier (pre-commit) record standing,
    // so ask before claiming nothing will collect it. An unreadable answer
    // counts as not queued: the flag summons a human when nothing else acts.
    const covered =
      queued ||
      (await createWorkflowSecretRetirementsRepository(env)
        .hasRetirement(secretVersionRef)
        .catch(() => false));
    logOrphanRisk(context, stored as StoredCredentialSecret, {
      reason: "secret_cleanup_failed",
      queuedForRetry: covered,
    });
    return;
  }
  // Destroyed. Discharge whatever obligation is on record. Best effort: a row
  // left behind costs one sweep that finds the version already gone.
  try {
    await createWorkflowSecretRetirementsRepository(env).deleteRetirementByVersionRef(
      secretVersionRef
    );
  } catch {
    // The sweeper reconciles it.
  }
}
