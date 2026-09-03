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

import { createRpc } from "@sdp/rpc/solana";
import type { Address } from "@solana/kit";
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { isDvpEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { deriveDvpTradeState } from "@/services/dvp/observe";
import { readDvpTradeObservation } from "@/services/dvp/read-chain";
import type { Env } from "@/types/env";

/**
 * Trades per tick. Each one costs a trade-account read plus a two-account batch,
 * so this is the RPC budget for the sweep, not a database concern.
 */
const BATCH_SIZE = 64;

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
    const released = await repository.releaseExpiredFundingClaims(blockHeight);
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
    trade.swapDvp as Address,
    {
      a: { escrow: trade.escrowA as Address, tokenProgram: trade.tokenProgramA as Address },
      b: { escrow: trade.escrowB as Address, tokenProgram: trade.tokenProgramB as Address },
    },
    blockHeight
  );

  const derived = deriveDvpTradeState(observation, trade, Date.now());

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
        escrowA: observation.legA.amount.toString(),
        targetA: trade.amountA,
        escrowB: observation.legB.amount.toString(),
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
