// Durable retirement of credential-secret versions, for every consumer of the
// credential secret store.
//
// Only GCP Secret Manager has external versions to destroy — the other
// backends keep ciphertext inline, and it dies with the row. A version written
// there outlives its request, so "clean up on failure" cannot be a catch block
// alone: the process can die between the write and the compensating destroy
// (worker loss), and the destroy itself can fail (timeout, outage). So the
// destroy is a durable obligation in `secret_retirements` plus a sweeper
// (`services/jobs/retire-orphaned-secrets.ts`), shared by every consumer
// (today, Privy provider credentials). `source_id` is a nullable
// trace column with no foreign key, and the sweeper resolves the store per row
// from `storage_backend`.
//
// The ordering rule is the only one that closes worker loss: record the obligation AFTER the backend write but
// BEFORE the database row that will reference the version; the transaction
// that commits the reference clears the obligation atomically. The two
// possible outcomes are "the row points at the version" and "the version is
// queued for destruction" — never neither.

import type { DatabaseClient as AppDb } from "@/db/client";
import { createSecretRetirementsRepository } from "@/db/repositories/repository-factory";
import { insertSecretRetirement } from "@/db/repositories/secret-retirement.repository.postgres";
import { getLogger } from "@/runtime/logger";
import {
  createCredentialSecretStore,
  type StoredCredentialSecret,
} from "@/services/credential-secret-store";
import type { Env } from "@/types/env";

/** Where the version came from, for logs and the queue's trace columns. */
export interface SecretRetirementContext {
  /** Log label, e.g. "privy". */
  provider: string;
  orgId: string | null;
  /**
   * The row the version belonged to (connection or credential id). Recorded in
   * the queue's `source_id` column, a nullable trace with no foreign key.
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

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Secret Manager's answer for destroying a version twice. The sweeper reads it
// the same way (`services/jobs/retire-orphaned-secrets.ts`): the version is
// gone, which is all this ever wanted.
function isAlreadyDestroyed(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("FAILED_PRECONDITION") || error.message.includes("NOT_FOUND"))
  );
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
      await createSecretRetirementsRepository(env).recordRetirement({
        organizationId: context.orgId ?? "unknown",
        sourceId: context.sourceId,
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
  await insertSecretRetirement(exec, {
    organizationId: context.orgId ?? "unknown",
    sourceId: context.sourceId,
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
 * own error message depends on the answer cannot claim a clean slate over
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
      // A version that is already gone is the outcome this call wanted — the
      // answer Secret Manager gives when a sweep got there first. Treating it as
      // a failure would queue work for a version that no longer exists.
      if (isAlreadyDestroyed(error)) {
        destroyed = true;
        break;
      }
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
      (await createSecretRetirementsRepository(env)
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
    await createSecretRetirementsRepository(env).deleteRetirementByVersionRef(secretVersionRef);
  } catch {
    // The sweeper reconciles it.
  }
  return "destroyed";
}
