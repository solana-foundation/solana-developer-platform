/**
 * Advancing DvP trades from what the chain shows (PRO-1840).
 *
 * This job exists because the DvP program is silent. A party funds a leg with a
 * plain `TransferChecked` to the escrow ATA — the program is never invoked — and
 * it emits no events for anything else either. There is no log line, no CPI and
 * no event that says a leg was funded, a trade settled, or a create landed. The
 * only source of truth is account state, so somebody has to go and look.
 *
 * Every status this writes is therefore an observation with a timestamp, never
 * an authority. `observed_at` is part of the answer.
 */

import { createRpc, getSignatureStatuses } from "@sdp/rpc/solana";
import { assertIsSignature } from "@solana/kit";
import { getDb } from "@/db";
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { createPostgresDvpLegFundingClaimRepository } from "@/db/repositories/dvp-leg-funding-claim.repository";
import { isDvpEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { resolveDvpClose } from "@/services/dvp/closing-transaction";
import { closeIsKnown, deriveDvpTradeState } from "@/services/dvp/observe";
import { readDvpTradeObservation } from "@/services/dvp/read-chain";
import type { Env } from "@/types/env";

/**
 * Trades per tick. Each costs one batch containing the trade and both escrows;
 * vanished trades with unknown closes can additionally scan bounded history.
 */
const BATCH_SIZE = 64;
const CLOSE_RESOLUTION_MAX_BACKOFF_MINUTES = 360;
const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Reconciles open DvP trades against the chain.
 *
 * @param env - API process environment.
 */
export async function reconcileDvpTrades(env: Env): Promise<void> {
  if (!isDvpEnabled(env)) {
    return;
  }

  const repository = createDvpTradeRepository(env);
  const trades = await repository.listOpenForReconciliation(BATCH_SIZE);
  if (trades.length === 0) {
    return;
  }

  const rpc = createRpc(env);

  // Read once for the whole batch. Every trade's create-expiry decision is made
  // against the same height, which also keeps the sweep internally consistent:
  // two trades in one tick cannot disagree about how far the cluster has got.
  let blockHeight: bigint;
  try {
    blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
  } catch (error) {
    getLogger().error({ error }, "dvp reconcile: failed to read block height");
    return;
  }

  // Funding claims that can no longer be live, released before anything else.
  // A claim is deliberately KEPT through an ambiguous failure, because the
  // transfer may still land — but past the signed transaction's last-valid
  // height it provably cannot, and a claim held beyond that made the leg
  // permanently unfundable with a hand-edit as the only way out.
  try {
    // Every side's claim lives on `dvp_leg_funding_claims`, keyed (trade, side)
    // and owned by the funding organization: the trade-level columns this sweep
    // used to release alongside are gone, and one table now carries every
    // funder — creator and party alike.
    const released = await createPostgresDvpLegFundingClaimRepository(getDb(env)).releaseExpired(
      blockHeight
    );
    if (released > 0) {
      getLogger().info(
        { released, blockHeight: blockHeight.toString() },
        "dvp reconcile: released funding claims whose transaction can no longer land"
      );
    }
  } catch (error) {
    // Never fatal to the sweep. Observing trades is the job; this is repair.
    getLogger().error({ error }, "dvp reconcile: failed to release expired funding claims");
  }

  // One row, two meanings: `funding_tx` set turns the claim from a lock into a
  // receipt, which is exactly why the sweep above refuses to touch it — a
  // transfer on the wire may still land. But past the signed transaction's
  // last-valid height it either landed or provably never will, and only the
  // chain can tell which: getSignatureStatuses with history search answers it,
  // where the status cache alone could not. This is the one place an RPC read
  // decides a DB deletion — the chain's answer is final here.
  try {
    const claims = createPostgresDvpLegFundingClaimRepository(getDb(env));
    const expiredBroadcast = await claims.listExpiredBroadcast(blockHeight);
    for (const claim of expiredBroadcast) {
      try {
        assertIsSignature(claim.signature);
        const [status] = await getSignatureStatuses(rpc, [claim.signature], {
          searchTransactionHistory: true,
        });
        // Two ways a transfer moved nothing: it never landed (null), or it
        // landed and FAILED (`err` set — fees consumed, zero tokens moved).
        // Both leave the claim neither lock nor receipt, so both release it.
        if (status === null || status.err !== null) {
          await claims.deleteBroadcastClaim(claim.tradeId, claim.side, claim.signature);
          getLogger().info(
            {
              event: "sdp_dvp_funding_claim_released",
              reason: status === null ? "never_landed" : "landed_failed",
              tradeId: claim.tradeId,
              side: claim.side,
              signature: claim.signature,
              err: status === null ? null : status.err,
            },
            "dvp reconcile: released broadcast funding claim whose transfer moved nothing"
          );
        }
      } catch (error) {
        // Never delete on a failed read: only a definitive "not found" from
        // the chain releases a broadcast claim. It keeps its lock and the
        // next tick retries.
        getLogger().error(
          {
            event: "sdp_dvp_funding_claim_resolution_failed",
            tradeId: claim.tradeId,
            side: claim.side,
            signature: claim.signature,
            error,
          },
          "dvp reconcile: expired broadcast funding claim could not be resolved"
        );
      }
    }
  } catch (error) {
    // Never fatal to the sweep, for the same reason as the release above.
    getLogger().error(
      { error },
      "dvp reconcile: failed to resolve expired broadcast funding claims"
    );
  }

  // Sequential on purpose. A batch of 64 fanned out with Promise.all would put
  // 192 account reads on the endpoint from one tick; the batch is already
  // bounded and pacing is the point. Same shape as every other job here.
  for (const trade of trades) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- pacing protects the RPC endpoint from a 64-way fanout.
      await reconcileTrade(repository, rpc, trade, blockHeight);
    } catch (error) {
      // One unreadable trade must not end the sweep. The row keeps its status
      // and its stale `observed_at`, so the next tick picks it up first.
      getLogger().error(
        { tradeId: trade.id, swapDvp: trade.swapDvp, error },
        "dvp reconcile: trade could not be reconciled"
      );
    }
  }
}

async function reconcileTrade(
  repository: ReturnType<typeof createDvpTradeRepository>,
  rpc: ReturnType<typeof createRpc>,
  trade: DvpTradeRow,
  blockHeight: bigint
): Promise<void> {
  const observation = await readDvpTradeObservation(
    rpc,
    trade.swapDvp,
    {
      a: {
        escrow: trade.escrowA,
        tokenProgram: trade.tokenProgramA,
        mint: trade.mintA,
      },
      b: {
        escrow: trade.escrowB,
        tokenProgram: trade.tokenProgramB,
        mint: trade.mintB,
      },
    },
    blockHeight
  );
  // A vanished trade with an unknown close can cost up to 10 × 100 signature
  // reads plus one transaction read per successful entry. The scan is bounded
  // by the create signature, the created-at floor, and persisted backoff.
  const now = Date.now();
  if (
    !observation.tradeAccountExists &&
    !closeIsKnown(trade) &&
    (trade.closeResolutionAfter === null || Date.parse(trade.closeResolutionAfter) <= now)
  ) {
    const lookup = await resolveDvpClose(
      rpc,
      trade.swapDvp,
      trade.createSignature,
      trade.createdAt
    );
    if (lookup.kind === "resolved") {
      observation.closeResolution = lookup;
    } else if (lookup.kind === "capped") {
      const attempts = trade.closeResolutionAttempts + 1;
      const delayMinutes = Math.min(
        2 ** trade.closeResolutionAttempts,
        CLOSE_RESOLUTION_MAX_BACKOFF_MINUTES
      );
      const after = new Date(now + delayMinutes * MILLISECONDS_PER_MINUTE).toISOString();
      await repository.deferCloseResolution({
        id: trade.id,
        expectedStatus: trade.status,
        attempts,
        after,
      });
      getLogger().warn(
        { trade_id: trade.id, attempts, after },
        "dvp reconcile: deferred capped close resolution"
      );
    }
  }

  const derived = deriveDvpTradeState(observation, trade, now);

  const updated = await repository.recordObservation({
    id: trade.id,
    // The status this derivation was computed from. A row something better
    // informed has already advanced makes this match nothing.
    expectedStatus: trade.status,
    status: derived.status,
    escrowAAmount: observation.legA.exists ? observation.legA.amount.toString() : null,
    escrowBAmount: observation.legB.exists ? observation.legB.amount.toString() : null,
    escrowAFrozen: observation.legA.exists ? observation.legA.frozen : null,
    escrowBFrozen: observation.legB.exists ? observation.legB.frozen : null,
    observedAt: new Date().toISOString(),
    closeSignature:
      observation.closeResolution === null ? null : observation.closeResolution.signature,
  });

  if (!updated) {
    // Lost the compare-and-swap. Not an error: something with a fresher view
    // moved the row, and this observation is the stale one.
    return;
  }

  if (derived.status !== trade.status) {
    getLogger().info(
      { tradeId: trade.id, from: trade.status, to: derived.status },
      "dvp reconcile: trade status advanced"
    );
  }

  // Both are settlement hazards rather than lifecycle states, so they are
  // logged rather than encoded in the status — a trade can be funded AND
  // over-funded, and collapsing that into one enum would lose the warning.
  if (derived.overFunded) {
    getLogger().warn(
      {
        tradeId: trade.id,
        escrowA: observation.legA.exists ? observation.legA.amount.toString() : null,
        targetA: trade.amountA,
        escrowB: observation.legB.exists ? observation.legB.amount.toString() : null,
        targetB: trade.amountB,
      },
      "dvp reconcile: escrow holds more than its target; settle refunds the surplus, which can revert the whole settlement on a transfer-hook mint"
    );
  }
  if (derived.frozenEscrow) {
    getLogger().warn(
      { tradeId: trade.id },
      "dvp reconcile: escrow is frozen; funding transfers into it will bounce until the mint freeze authority thaws it"
    );
  }
}
