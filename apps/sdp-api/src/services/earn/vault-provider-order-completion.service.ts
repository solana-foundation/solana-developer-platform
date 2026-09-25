import { supportsVaultProviderOrderCompletion } from "@sdp/earn/capabilities";
import type { EarnProviderOrderCompletionProvider } from "@sdp/earn/types";
import { EARN_PROVIDER_DEPOSIT_SETTLEMENT } from "@sdp/types";
import { getDb } from "@/db";
import { createPostgresEarnMovementsRepository } from "@/db/repositories/earn-movements.repository";
import { getLogger } from "@/runtime/logger";
import { resolveVaultDirectClient } from "@/services/earn/execution-registry";
import { createVaultDeadline } from "@/services/earn/vault-deadline";
import type { Env } from "@/types/env";

/**
 * The authenticated provider reconciler the settlement boundary has deferred
 * to since migration 0115: it correlates a chain-final provider-order deposit
 * to the provider's OWN completion record and stamps the durable fact
 * (`provider_completed_at`) that closes the row.
 *
 * One fact, moved once, bound to the order that justifies it. Writing the
 * stamp — the moment AND the provider's own order identity — releases the
 * provider-order row on the `?settled=` surface and releases its cross-key
 * deposit-intent claim with it — both read the same settlement predicate — so
 * a later same-amount deposit with a fresh key finally starts a NEW movement
 * instead of replaying a completed one. The identity is what keeps the
 * correlation exclusive: the reader skips orders the ledger has already
 * accepted, and the unique index on (provider, order reference) refuses a
 * second movement claiming the same order's completion, so one order can
 * never settle two deposits. Nothing else releases a provider-order row:
 * chain finality never does (the order may still be pending there), and a
 * legacy `settled_at` stamp never does.
 *
 * Fail closed, like every settlement claim: a row the provider cannot
 * demonstrably complete — unreachable feed, malformed record, ambiguous or
 * absent match, order still working — keeps its claim and its unsettled row
 * and is retried on a later tick. The stamp is written only from the
 * provider's answer, never inferred from the chain or from the age of a row.
 */

/** How far back the completion pass re-looks: order feeds are finite too. */
export const PROVIDER_ORDER_COMPLETION_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;
/** Minimum spacing between two completion attempts on the same movement. */
export const PROVIDER_ORDER_COMPLETION_RETRY_MS = 15 * 60 * 1_000;
const PROVIDER_ORDER_COMPLETION_BATCH_SIZE = 25;
/**
 * How many consumed order identities the pass feeds each completion reader.
 * The reader needs only the orders that could still candidate for an open
 * deposit — recent completions — so a bounded newest-first slice keeps the
 * exclusion set small without letting an old consumed order resurface.
 */
const PROVIDER_ORDER_COMPLETION_EXCLUSION_LIMIT = 500;

export interface ProviderOrderCompletionStats {
  claimed: number;
  /** Rows whose provider demonstrated completion; the fact was stamped. */
  completed: number;
  /** Claimed rows whose provider did not (yet) demonstrate completion. */
  unobserved: number;
  /** Rows whose completion read or write threw (feed outage, DB failure). */
  errors: number;
}

/**
 * The providers whose DEPOSITS are provider orders per the settlement registry
 * — the set the completion pass can ever serve. Whether a deployment can
 * actually authenticate a provider's completion is per-provider below: the
 * executing client must exist and carry the completion capability.
 */
function providerOrderDepositProviders(): string[] {
  return Object.entries(EARN_PROVIDER_DEPOSIT_SETTLEMENT)
    .filter(([, settlement]) => settlement === "provider_order")
    .map(([provider]) => provider);
}

export async function completeProviderOrderDeposits(
  env: Env,
  {
    limit = PROVIDER_ORDER_COMPLETION_BATCH_SIZE,
    now = Date.now(),
  }: { limit?: number; now?: number } = {}
): Promise<ProviderOrderCompletionStats> {
  const stats: ProviderOrderCompletionStats = {
    claimed: 0,
    completed: 0,
    unobserved: 0,
    errors: 0,
  };

  // Construction is synchronous and I/O-free; a client that cannot be built
  // simply does not join the supported set, and its rows stay untouched.
  const deadline = createVaultDeadline();
  const supported = new Map<string, EarnProviderOrderCompletionProvider>();
  for (const provider of providerOrderDepositProviders()) {
    const client = resolveVaultDirectClient(env, provider, deadline);
    if (!client) continue;
    if (!supportsVaultProviderOrderCompletion(client)) continue;
    supported.set(provider, client);
  }
  if (supported.size === 0) return stats;

  const ledger = createPostgresEarnMovementsRepository(getDb(env));
  // The order identities the ledger has already accepted, per provider: an
  // order that completed one movement must never demonstrate another's
  // settlement. The reader skips these candidates, and the unique index on
  // (provider, order reference) closes the race for anything consumed after
  // this read — a stamp that arrives second simply does not apply, and the
  // row stays open for its own order on a later tick.
  const consumed = await ledger.listCompletedProviderOrderReferences({
    providers: [...supported.keys()],
    limit: PROVIDER_ORDER_COMPLETION_EXCLUSION_LIMIT,
  });
  const consumedByProvider = new Map<string, string[]>();
  for (const { provider, orderReference } of consumed) {
    const references = consumedByProvider.get(provider);
    if (references) references.push(orderReference);
    else consumedByProvider.set(provider, [orderReference]);
  }

  const movements = await ledger.claimUncompletedProviderOrderDeposits({
    limit,
    providers: [...supported.keys()],
    retryBefore: new Date(now - PROVIDER_ORDER_COMPLETION_RETRY_MS).toISOString(),
  });
  stats.claimed = movements.length;

  for (const movement of movements) {
    // A provider-order deposit funded the order from the custody wallet that
    // signed it; the strategy's provider reference is the instrument.
    const owner = movement.source_address ?? movement.owner_address;
    const providerReference = movement.vault_address ?? movement.provider_reference;
    const client = supported.get(movement.provider);
    if (!client || !owner || !providerReference) {
      // The claim cannot produce these (the SQL pins direction/model, and the
      // supported map pinned the provider), but an uncorrelatable row must
      // never fail the pass: leave it for a later tick with its state intact.
      stats.unobserved += 1;
      continue;
    }
    try {
      const completion = await client.readDepositOrderCompletion(
        { env, environment: movement.environment },
        {
          owner,
          providerReference,
          amountRequested: movement.amount_requested,
          // The movement's own record instant: the correlation may only accept
          // orders that cannot be OLDER than this deposit (an older completed
          // purchase of the same wallet, fund, and amount must never settle it).
          movementCreatedAt: movement.created_at,
          excludedOrderReferences: consumedByProvider.get(movement.provider) ?? [],
        }
      );
      if (!completion) {
        stats.unobserved += 1;
        continue;
      }
      getLogger().info(
        {
          movementId: movement.id,
          provider: movement.provider,
          orderReference: completion.orderReference,
        },
        "earn provider-order reconciliation: deposit completion demonstrated by the provider"
      );
      const stamped = await ledger.recordVaultMovementProviderCompletion({
        movementId: movement.id,
        organizationId: movement.organization_id,
        completedAt: completion.completedAt ?? new Date().toISOString(),
        // The fact and the identity that justifies it move together: the
        // stamp names the order, and the database refuses a second movement
        // claiming the same one.
        orderReference: completion.orderReference,
      });
      if (stamped) {
        stats.completed += 1;
      } else {
        // A null means a concurrent writer stamped this row first, the row
        // moved on, or another movement already consumed that order's
        // completion (the unique arbiter). Re-reading tells them apart: a row
        // still missing its fact was refused because the ORDER was someone
        // else's — this pass's honest "not yet", retried with the consumed
        // identity excluded so the deposit's own order can close it.
        const current = await ledger.getMovementById({
          movementId: movement.id,
          organizationId: movement.organization_id,
        });
        if (current?.provider_completed_at == null) stats.unobserved += 1;
      }
    } catch (error) {
      stats.errors += 1;
      getLogger().error(
        { movementId: movement.id, provider: movement.provider, error },
        "earn provider-order reconciliation: completion read failed"
      );
    }
  }
  return stats;
}
