/**
 * Reading a single trade's chain state on demand, outside the sweep.
 *
 * The reconciler runs once a minute, which is the right cadence for noticing a
 * counterparty's deposit — nobody tells us when that lands. It is the wrong
 * cadence for an action SDP just performed itself: funding a leg returned 200,
 * the tokens moved, and the page went on showing "Waiting on funds" for up to
 * a minute afterwards. The honest reading of that is that nothing happened.
 *
 * So an action that changes chain state observes its own result rather than
 * waiting to be told about it by a job.
 */

import { confirmTransaction, createRpc } from "@sdp/rpc/solana";
import type { Address, Signature } from "@solana/kit";
import { createDvpTradeRepository, type DvpTradeRow } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import type { Env } from "@/types/env";
import { deriveDvpTradeState } from "./observe";
import { readDvpTradeObservation } from "./read-chain";

/**
 * Observes one trade now and records what it finds.
 *
 * Never throws. The caller has already done the thing that mattered — the
 * transfer is broadcast, the money has moved — and failing their request
 * because a follow-up read timed out would report a failure that did not
 * happen. A missed observation costs at most one sweep of latency, which is
 * exactly where this started.
 *
 * @param env - API process environment.
 * @param trade - The trade to re-read.
 * @param awaitSignature - A transaction to confirm first, so the read happens
 *   after the effect it is meant to see rather than racing it.
 * @returns The updated row, or null when nothing was written — an unreadable
 *   chain, or the sweep having moved the row first, in which case the caller's
 *   own copy is the stale one and it should re-read rather than trust this.
 */
export async function observeDvpTradeNow(
  env: Env,
  trade: DvpTradeRow,
  awaitSignature?: Signature
): Promise<DvpTradeRow | null> {
  try {
    const rpc = createRpc(env);

    if (awaitSignature) {
      // Reading before the transfer confirms would record the balance it had
      // beforehand and leave the row saying the opposite of what just happened.
      await confirmTransaction(rpc, awaitSignature, { timeoutMs: 15_000 });
    }

    const blockHeight = await rpc.getBlockHeight({ commitment: "confirmed" }).send();
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

    return await createDvpTradeRepository(env).recordObservation({
      id: trade.id,
      // Same compare-and-swap the sweep uses: if the reconciler moved the row
      // in between, its view is the fresher one and this write matches nothing.
      expectedStatus: trade.status,
      status: derived.status,
      escrowAAmount: observation.legA.exists ? observation.legA.amount.toString() : null,
      escrowBAmount: observation.legB.exists ? observation.legB.amount.toString() : null,
      escrowAFrozen: observation.legA.exists ? observation.legA.frozen : null,
      escrowBFrozen: observation.legB.exists ? observation.legB.frozen : null,
      observedAt: new Date().toISOString(),
    });
  } catch (error) {
    getLogger().warn(
      { error, tradeId: trade.id },
      "dvp: could not observe the trade immediately; the sweep will pick it up"
    );
    return null;
  }
}

/** Statuses that can still change on chain without anyone telling us. */
const OPEN_STATUSES: ReadonlySet<string> = new Set([
  "created",
  "partially_funded",
  "funded",
  "creating",
]);

/**
 * How stale a reading may be before a page asking for the trade pays for a
 * fresh one.
 *
 * The sweep's once-a-minute cadence is right for a background job and wrong for
 * somebody sitting on the page: a counterparty's deposit is the one event this
 * product exists to show, and waiting up to a minute to show it is what makes
 * a working trade look broken. Short enough to feel live, long enough that a
 * polling page costs one chain read every few seconds rather than one per
 * request.
 */
const OBSERVATION_MAX_AGE_MS = 10_000;

/**
 * Re-reads a trade if the last observation is too old to answer with.
 *
 * Only for trades that can still change: a settled or cancelled trade is over,
 * and re-reading one would spend a chain call to confirm it is still over.
 *
 * @param env - API process environment.
 * @param trade - The trade as it was last stored.
 * @param now - Current time, injectable for tests.
 * @returns A fresher row when one was written, otherwise the row given.
 */
export async function observeDvpTradeIfStale(
  env: Env,
  trade: DvpTradeRow,
  now: number = Date.now()
): Promise<DvpTradeRow> {
  if (!OPEN_STATUSES.has(trade.status)) {
    return trade;
  }
  const observedAt = trade.observedAt ? Date.parse(trade.observedAt) : Number.NaN;
  // A trade never observed is the strongest case for reading it, not the
  // weakest: NaN must not fall through to "recent enough".
  if (Number.isFinite(observedAt) && now - observedAt < OBSERVATION_MAX_AGE_MS) {
    return trade;
  }
  return (await observeDvpTradeNow(env, trade)) ?? trade;
}
