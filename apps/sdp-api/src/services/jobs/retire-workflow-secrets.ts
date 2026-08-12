// Retries secret-version destroys that failed at request time.
//
// Retiring a workflow action's signing secret happens after the rotation or delete it
// follows has already committed, so it cannot fail the request — a backend error is
// queued (workflow_action_secret_retirements) instead. This drains that queue. Until it
// existed, a single failed destroy left the superseded credential readable in Secret
// Manager forever, with nothing referencing it and nothing retrying.

import { createWorkflowSecretRetirementsRepository } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import {
  type CredentialSecretStorageBackend,
  type CredentialSecretStore,
  createCredentialSecretStore,
} from "@/services/credential-secret-store";
import type { Env } from "@/types/env";

// A tick's worth of work. The queue only grows when the backend is failing, so this is a
// drain rate rather than a throughput target.
const BATCH_SIZE = 25;
const BASE_RETRY_MINUTES = 5;
const MAX_RETRY_MINUTES = 6 * 60;

export interface RetireWorkflowSecretsResult {
  retired: number;
  failed: number;
}

// Exponential backoff, capped: a permission error that needs a human should not be
// retried every minute for days, but the row is never abandoned — an orphaned credential
// stays queued until it is actually destroyed.
function nextAttemptIso(now: Date, attemptCount: number): string {
  const minutes = Math.min(BASE_RETRY_MINUTES * 2 ** attemptCount, MAX_RETRY_MINUTES);
  return new Date(now.getTime() + minutes * 60 * 1000).toISOString();
}

function isAlreadyDestroyed(error: unknown): boolean {
  return error instanceof Error && error.message.includes("FAILED_PRECONDITION");
}

function isKnownBackend(value: string): value is CredentialSecretStorageBackend {
  return value === "gcp_secret_manager" || value === "encrypted_db" || value === "runtime_env";
}

// The store a row's version actually lives in — resolved from the backend recorded ON THE
// ROW, never from whatever the deployment resolves to today. A migration (say
// gcp_secret_manager → encrypted_db) otherwise handed every queued GCP version to a store
// that has no external versions at all: UNSUPPORTED_OPERATION on every sweep, forever,
// with the credential still readable in Secret Manager. Both other consumers of persisted
// credentials already resolve per row; `storage_backend` exists on 0056 for this.
//
// Built at most once per backend per batch, and a backend that cannot be built throws for
// every row naming it — the caller's catch treats that like any other failed destroy, so
// the row backs off and stays queued instead of being abandoned.
function storeForBackend(
  env: Env,
  backend: string,
  cache: Map<string, CredentialSecretStore | Error>
): CredentialSecretStore {
  const cached = cache.get(backend);
  if (cached) {
    if (cached instanceof Error) {
      throw cached;
    }
    return cached;
  }

  let resolved: CredentialSecretStore | Error;
  if (isKnownBackend(backend)) {
    try {
      resolved = createCredentialSecretStore(env, backend);
    } catch (error) {
      resolved = error instanceof Error ? error : new Error(String(error));
    }
  } else {
    // A value that is not a backend at all: the row still names a real orphan, so it is
    // kept and reported rather than silently swept past.
    resolved = new Error(`Unknown credential storage backend: ${backend}`);
  }

  cache.set(backend, resolved);
  if (resolved instanceof Error) {
    throw resolved;
  }
  return resolved;
}

export async function retireOrphanedActionSecrets(
  env: Env,
  now = new Date()
): Promise<RetireWorkflowSecretsResult> {
  const result: RetireWorkflowSecretsResult = { retired: 0, failed: 0 };
  const repo = createWorkflowSecretRetirementsRepository(env);

  const due = await repo.listDueRetirements({ dueBefore: now.toISOString(), limit: BATCH_SIZE });
  if (due.length === 0) {
    return result;
  }

  const stores = new Map<string, CredentialSecretStore | Error>();

  for (const row of due) {
    try {
      const secretStore = storeForBackend(env, row.storage_backend, stores);
      await secretStore.destroyVersion({ secretVersionRef: row.secret_version_ref });
      await repo.deleteRetirement(row.id);
      result.retired += 1;
    } catch (error) {
      // A version that is already gone is the outcome this row wanted. Secret Manager
      // answers FAILED_PRECONDITION for destroying one twice, which is exactly what a row
      // left behind by a successful request-time destroy looks like — clearing it beats
      // retrying it to the backoff cap forever.
      if (isAlreadyDestroyed(error)) {
        await repo.deleteRetirement(row.id);
        result.retired += 1;
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      await repo.rescheduleRetirement({
        id: row.id,
        error: reason,
        nextAttemptAt: nextAttemptIso(now, row.attempt_count + 1),
      });
      result.failed += 1;
      getLogger().error(
        {
          secretVersionRef: row.secret_version_ref,
          workflowId: row.workflow_id,
          attemptCount: row.attempt_count + 1,
          error: reason,
          reason: "secret_cleanup_retry_failed",
        },
        "workflow_action_secret_orphan_risk"
      );
    }
  }

  return result;
}
