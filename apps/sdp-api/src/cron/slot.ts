/**
 * Shared cadence slot for tasks that ride the managed Cloud Run Job.
 *
 * The job ticks every five minutes (Cloud Scheduler in sdp-infra), which is far
 * more often than most tasks want to run. Each tick claims its task's own Redis
 * slot first and skips quietly when the slot is held, so a task's real cadence is
 * its own constant rather than the job's schedule — and overlapping executions
 * lose cleanly instead of double-processing.
 *
 * The slot value is a unique claim token that embeds its own expiry
 * (`<expiresAtEpochMs>:<uuid>`), and every transition is atomic on the exact prior
 * value: an empty slot is claimed with compareAndSet(null → token), an expired one
 * is taken over with compareAndSet(staleValue → token), and a failed run releases
 * with compareAndDelete(token) — a server-side no-op unless the claim still belongs
 * to this execution, so a run that outlives its slot can never delete a newer
 * tick's claim.
 *
 * Note `compareAndSet` writes with no PX, so expiry lives ENTIRELY in the token:
 * a task that dies mid-run self-heals once its token's embedded expiry passes
 * (worst case, one skipped window). Set a TTL just under the cadence so the next
 * on-cadence tick finds a fresh slot.
 *
 * Extracted from the catalogue sync when the deposit sweep became the second
 * rider (PRO-1669) — the mechanics are subtle enough that a third copy would be a
 * liability. Its mechanics are covered through both riders' suites
 * (`earn-catalogue-sync.node.test.ts`, `earn-deposit-sweep.node.test.ts`) rather
 * than a dedicated file, because what actually needs pinning is each rider's
 * WIRING — its key, its TTL, and that it releases inside its own catch — which is
 * only observable at the call site.
 */

import { randomUUID } from "node:crypto";
import type { KVStore } from "@/runtime/kv";
import { getLogger } from "@/runtime/logger";

/**
 * Claim token wire format: `<expiresAtEpochMs>:<uuid>`. Wall-clock epoch is
 * deliberate — expiry must be comparable across job executions (a monotonic
 * reading is process-local); NTP keeps cross-instance skew far below the minute
 * granularity that matters here.
 */
function makeSlotToken(ttlSeconds: number): string {
  return `${Date.now() + ttlSeconds * 1000}:${randomUUID()}`;
}

/**
 * A value that doesn't parse — including the pre-token "1" an older build's
 * INCR-based claim may have left behind — reads as expired, so it is taken over
 * rather than wedging the slot forever.
 */
function slotExpiresAtMs(value: string): number {
  const separator = value.indexOf(":");
  if (separator === -1) {
    return 0;
  }
  const expiresAt = Number(value.slice(0, separator));
  return Number.isFinite(expiresAt) ? expiresAt : 0;
}

/**
 * Claim the slot, returning this execution's token, or null when the slot is held
 * by a live claim (or a racer wins the same transition). Both claim shapes are
 * single compareAndSet transitions on the exact observed value, so two ticks can
 * never both win.
 */
export async function claimCronSlot(
  cache: KVStore,
  key: string,
  ttlSeconds: number
): Promise<string | null> {
  const token = makeSlotToken(ttlSeconds);
  const existing = await cache.get(key);
  if (existing === null) {
    const won = await cache.compareAndSet(key, null, token);
    return won ? token : null;
  }
  if (slotExpiresAtMs(existing) > Date.now()) {
    return null;
  }
  const won = await cache.compareAndSet(key, existing, token);
  return won ? token : null;
}

/**
 * Release a claim this execution still owns, so the next tick retries instead of
 * waiting out the whole window.
 *
 * Never throws: a release failure must not mask the error that prompted it, and
 * the token's embedded expiry already bounds the damage to one skipped window.
 */
export async function releaseCronSlot(
  cache: KVStore,
  key: string,
  token: string,
  taskLabel: string
): Promise<void> {
  try {
    // Atomic owner check and delete in one step: no-ops unless the slot still
    // holds this execution's token, so a newer tick's takeover can never be
    // cancelled from here.
    await cache.compareAndDelete(key, token);
  } catch (releaseErr) {
    getLogger().error(
      { error: releaseErr instanceof Error ? releaseErr.message : String(releaseErr) },
      `${taskLabel}: failed to release cadence slot after a failed run`
    );
  }
}

/**
 * Reject when the work outlives its deadline, enforcing lease validity: a claim
 * only guarantees mutual exclusion while the holder's work is bounded well below
 * the claim's expiry.
 *
 * The losing promise is not cancelled — the tick's failure exits the one-shot job
 * process, which reaps any hung I/O — and the timer is unref'd/cleared so a fast
 * pass neither leaks it nor holds the process open.
 */
export async function withCronDeadline<T>(
  work: Promise<T>,
  deadlineSeconds: number,
  taskLabel: string
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${taskLabel} exceeded its ${deadlineSeconds}s deadline`));
    }, deadlineSeconds * 1000);
    timer.unref();
  });
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
