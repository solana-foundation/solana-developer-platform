// Retries secret-version destroys that failed at request time.
//
// Retiring a workflow action's signing secret happens after the rotation or delete it
// follows has already committed, so it cannot fail the request — a backend error is
// queued (workflow_action_secret_retirements) instead. This drains that queue. Until it
// existed, a single failed destroy left the superseded credential readable in Secret
// Manager forever, with nothing referencing it and nothing retrying.

import { createWorkflowSecretRetirementsRepository } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { createCredentialSecretStore } from "@/services/credential-secret-store";
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

  let secretStore: ReturnType<typeof createCredentialSecretStore>;
  try {
    secretStore = createCredentialSecretStore(env);
  } catch {
    // Unconfigured deployment. The rows stay queued: they name versions in a backend
    // this process cannot reach, and dropping them would lose the only record of them.
    return result;
  }

  for (const row of due) {
    try {
      await secretStore.destroyVersion({ secretVersionRef: row.secret_version_ref });
      await repo.deleteRetirement(row.id);
      result.retired += 1;
    } catch (error) {
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
