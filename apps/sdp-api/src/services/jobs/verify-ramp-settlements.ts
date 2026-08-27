import { createSystemPaymentsRepository } from "@/db/repositories";
import { isRampSettlementVerificationEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { verifyRampSettlement } from "@/services/ramps/settlement-verifier";
import type { Env } from "@/types/env";

/**
 * Rows served per tick. Each one costs a getTransaction, so this bounds RPC spend per run
 * rather than letting a backlog fan out without limit.
 */
const VERIFICATION_PAGE_SIZE = 25;

/**
 * Attempts before a row stops being served. A provider can report a hash that never lands, and
 * without a cap that row would be polled forever at a cost per attempt. Capped rows keep
 * reporting as unverified, which is the honest outcome rather than a hidden retry loop.
 */
const MAX_VERIFICATION_ATTEMPTS = 10;

/**
 * How long a claimed row stays excluded from the queue. Must comfortably exceed the time a full
 * page spends in Solana RPC, or a row is re-claimed mid-flight and its attempt allowance is spent
 * twice for one real polling opportunity. Generous on purpose: the cost of a long lease is that a
 * crashed worker's row waits, which is harmless, while the cost of a short one is a burnt attempt.
 */
const CLAIM_LEASE_MS = 5 * 60 * 1000;

/**
 * Proves, or fails to prove, that provider-reported ramp settlements actually happened on chain (#559).
 *
 * This job only ever moves a transfer from unproven to proven. It never writes a transfer status,
 * so a bug here can leave a real settlement reported as unverified, which is visible and
 * recoverable, but can never mark an unsettled transfer as complete.
 */
export async function verifyRampSettlements(env: Env): Promise<void> {
  if (!isRampSettlementVerificationEnabled(env)) {
    return;
  }

  const repo = createSystemPaymentsRepository(env);
  const now = Date.now();
  const claimedAt = new Date(now).toISOString();
  const claimToken = crypto.randomUUID();
  const pending = await repo.claimRampTransfersToVerify({
    maxAttempts: MAX_VERIFICATION_ATTEMPTS,
    limit: VERIFICATION_PAGE_SIZE,
    claimedAt,
    claimToken,
    claimedUntil: new Date(now + CLAIM_LEASE_MS).toISOString(),
  });

  for (const transfer of pending) {
    const polledAt = new Date().toISOString();
    try {
      const outcome = await verifyRampSettlement(env, transfer);

      if (outcome.verified) {
        await repo.advanceRampVerification({
          transferId: transfer.id,
          polledAt,
          claimToken,
          verifiedAt: polledAt,
          slot: outcome.slot,
          method: outcome.method,
        });
        continue;
      }

      // Not proven. Advance the cursor and the attempt count so the row rotates to the back of
      // the queue, and record why: a reason that repeats across many rows is a signal about the
      // provider, not about one transfer.
      await repo.advanceRampVerification({ transferId: transfer.id, polledAt, claimToken });
      getLogger().info({
        event: "ramp_settlement_unverified",
        transfer_id: transfer.id,
        provider: transfer.provider,
        attempts: transfer.verification_attempts + 1,
        reason: outcome.reason,
      });
    } catch (error) {
      // One bad row must not stop the page. Still burn an attempt, or a row that always throws
      // would be retried on every tick forever.
      getLogger().error({
        event: "ramp_settlement_verification_failed",
        transfer_id: transfer.id,
        error: error instanceof Error ? error.message : String(error),
      });
      await repo
        .advanceRampVerification({ transferId: transfer.id, polledAt, claimToken })
        .catch(() => undefined);
    }
  }
}
