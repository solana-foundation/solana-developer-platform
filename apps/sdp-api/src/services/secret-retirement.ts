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

/**
 * What became of a version this process tried to retire.
 *
 * - `destroyed` — gone from the backend; nothing is owed.
 * - `queued` — still in the backend, but a durable row is on record and the
 *   sweeper will collect it.
 * - `orphaned` — still in the backend with nothing on record anywhere. The one
 *   outcome that needs a human, and the one no caller may describe as clean.
 */
export type SecretRetirementOutcome = "destroyed" | "queued" | "orphaned";

// This insert is the ONLY durable record that an orphaned credential still
// needs destroying, so one attempt is not enough to stake it on. Everything
// that realistically fails it is transient, and the caller's own database
// write succeeded moments before or is about to run — so the budget is a
// fraction of a second of quick retries, never a failed request.
const QUEUE_ATTEMPTS = 3;
const QUEUE_BACKOFF_MS = 50;

// The destroy gets its own retries for the same reason, and one that matters
// more: when the queue cannot be written the database is usually the thing
// that is broken, which leaves the backend the only party still able to end
// the leak. Conceding after a single blip there is how a version survives with
// nothing on record.
const DESTROY_ATTEMPTS = 3;
const DESTROY_BACKOFF_MS = 50;

// How long a PROVISIONAL obligation is withheld from the sweeper.
//
// That row is committed before the transaction that would reference its
// version, so for a moment the queue says "destroy this" about a version a
// request is still about to make live. Due immediately, a sweep landing inside
// that window destroys the key and the transaction then commits rows pointing
// at nothing — the credential is installed dead. The grace period covers the
// rest of the request by a wide margin; worker loss is still collected, just a
// few minutes later, and lateness costs nothing here while destroying a live
// credential costs the tenant their connection.
const PROVISIONAL_GRACE_MS = 15 * 60 * 1000;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function queueRetirement(
  env: Env,
  context: SecretRetirementContext,
  stored: StoredCredentialSecret,
  reason: string,
  // Absent → due now, which is only ever right for a version already orphaned.
  nextAttemptAt?: string
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
        nextAttemptAt: nextAttemptAt ?? null,
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
    "written for a row that has not committed yet",
    // Held back from the sweeper: this version is not orphaned yet, it is
    // unreferenced only because the request that will reference it is still
    // running. Acting on it now would destroy a key about to go live.
    new Date(Date.now() + PROVISIONAL_GRACE_MS).toISOString()
  );
  if (queued) {
    return;
  }
  // Destroy now, while this process still remembers the version — with the
  // queue unwritable this is the only thing that can stop the leak, so it
  // retries, and it re-attempts the queue if it cannot.
  const outcome = await destroySecretVersion(env, stored, context);
  if (outcome === "orphaned") {
    // The version outlived every attempt to destroy it AND every attempt to
    // record it. No row was created, so nothing references it — but saying
    // "nothing was created" full stop would describe a clean slate over a
    // credential still readable in the backend. `destroySecretVersion` has
    // already logged it with queuedForRetry:false, which is what summons a
    // human; this wording is the same admission in the response.
    throw serviceUnavailable(
      "Credential cleanup could not be completed and could not be recorded; no connection was created — retry the request"
    );
  }
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
 *
 * Returns what became of the version rather than nothing, so a caller whose
 * own error message depends on the answer — `queuePendingSecretVersion`, which
 * tells the tenant the create was abandoned — cannot claim a clean slate over
 * a version that is still readable with nothing on record.
 */
export async function destroySecretVersion(
  env: Env,
  stored: StoredCredentialSecret | null | undefined,
  context: SecretRetirementContext
): Promise<SecretRetirementOutcome> {
  const secretVersionRef = destroyableVersionRef(stored);
  if (!secretVersionRef) {
    // Nothing outlives the row for this backend, so there is nothing to owe.
    return "destroyed";
  }

  // Building the store is inside the loop on purpose: a store this process
  // cannot construct is unreachable, not absent, and the queue is exactly what
  // "could not retire it now" means here.
  let failure: unknown;
  let destroyed = false;
  for (let attempt = 1; attempt <= DESTROY_ATTEMPTS; attempt++) {
    try {
      await createCredentialSecretStore(env, "gcp_secret_manager").destroyVersion({
        secretVersionRef,
      });
      destroyed = true;
      break;
    } catch (error) {
      failure = error;
      if (attempt < DESTROY_ATTEMPTS) {
        await pause(DESTROY_BACKOFF_MS * attempt);
      }
    }
  }

  if (!destroyed) {
    const reason = failure instanceof Error ? failure.message : String(failure);
    // Due now, explicitly: reaching here means the version really is orphaned,
    // so if a provisional row is standing with a grace period, this revokes it
    // and hands the version to the next sweep.
    const queued = await queueRetirement(
      env,
      context,
      stored as StoredCredentialSecret,
      reason,
      new Date().toISOString()
    );
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
    return covered ? "queued" : "orphaned";
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
  return "destroyed";
}
