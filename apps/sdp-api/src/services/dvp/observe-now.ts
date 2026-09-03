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
 */
export async function observeDvpTradeNow(
  env: Env,
  trade: DvpTradeRow,
  awaitSignature?: Signature
): Promise<void> {
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

    await createDvpTradeRepository(env).recordObservation({
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
  }
}
