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
import {
  createPostgresDvpLegFundingClaimRepository,
  type DvpLegFundingClaim,
} from "@/db/repositories/dvp-leg-funding-claim.repository";
import {
  createPostgresDvpLegTransferRepository,
  type DvpLegTransferRepository,
} from "@/db/repositories/dvp-leg-transfer.repository";
import { isMarketsEnabled } from "@/lib/feature-flags";
import { getLogger } from "@/runtime/logger";
import { resolveDvpClose } from "@/services/dvp/closing-transaction";
import { classifyDvpFundingReceipt } from "@/services/dvp/funding-receipt";
import {
  createDvpEscrowHistoryReader,
  type DvpEscrowHistoryReader,
  type DvpLegTransferBudget,
  syncDvpLegTransfers,
} from "@/services/dvp/leg-transfers";
import { closeIsKnown, deriveDvpTradeState } from "@/services/dvp/observe";
import { readDvpTradeObservation } from "@/services/dvp/read-chain";
import type { Env } from "@/types/env";

/**
 * Trades per tick. Each costs one batch containing the trade and both escrows;
 * vanished trades with unknown closes can additionally scan bounded history.
 */
const BATCH_SIZE = 64;
/**
 * Transactions the escrow ledger may read in one sweep, across every leg. A
 * leg left unread carries on from its read position next sweep.
 */
const TRANSFER_TRANSACTION_BUDGET = 128;
/**
 * A leg whose trade looks unchanged is still re-read this often: a deposit and
 * a reclaim between two sweeps leave the balance where it was.
 */
const TRANSFER_RESCAN_MS = 5 * 60_000;
/** `getSignatureStatuses` answers at most this many signatures per call. */
const SIGNATURE_STATUS_CHUNK = 256;
const CLOSE_RESOLUTION_MAX_BACKOFF_MINUTES = 360;
const MILLISECONDS_PER_MINUTE = 60_000;

/**
 * Reconciles open DvP trades against the chain.
 *
 * @param env - API process environment.
 */
export async function reconcileDvpTrades(env: Env): Promise<void> {
  if (!isMarketsEnabled(env)) {
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
    // Same reasoning for a close lock: past its height the settle or cancel
    // either landed, and the sweep below records the close from the chain, or
    // never will, and the trade can be closed again.
    const releasedCloses = await repository.releaseExpiredCloseClaims(blockHeight);
    if (releasedCloses > 0) {
      getLogger().info(
        { released: releasedCloses, blockHeight: blockHeight.toString() },
        "dvp reconcile: released close locks whose transaction can no longer land"
      );
    }
  } catch (error) {
    // Never fatal to the sweep. Observing trades is the job; this is repair.
    getLogger().error(
      { error },
      "dvp reconcile: failed to release expired funding claims or close locks"
    );
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
    // One status call per chunk, not per receipt: a backlog of expired
    // receipts used to cost one RPC call each on every tick.
    for (let start = 0; start < expiredBroadcast.length; start += SIGNATURE_STATUS_CHUNK) {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- one chunk at a time paces the RPC endpoint.
      await resolveExpiredReceipts(
        claims,
        rpc,
        expiredBroadcast.slice(start, start + SIGNATURE_STATUS_CHUNK)
      );
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
  const ledger: TransferLedger = {
    transfers: createPostgresDvpLegTransferRepository(getDb(env)),
    reader: createDvpEscrowHistoryReader(rpc),
    budget: { remaining: TRANSFER_TRANSACTION_BUDGET },
  };
  for (const trade of trades) {
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- pacing protects the RPC endpoint from a 64-way fanout.
      await reconcileTrade(repository, ledger, rpc, trade, blockHeight);
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

/** What the escrow transfer ledger needs for one sweep. */
interface TransferLedger {
  transfers: DvpLegTransferRepository;
  reader: DvpEscrowHistoryReader;
  /** Shared by every leg in the sweep. */
  budget: DvpLegTransferBudget;
}

/**
 * Brings both legs' transfer ledgers up to date when they may have moved.
 *
 * Never fatal to the trade's reconciliation: the ledger is a record of what the
 * observation already shows, and a leg that fails to read is retried next sweep.
 */
async function syncTradeTransfers(
  ledger: TransferLedger,
  trade: DvpTradeRow,
  changed: boolean,
  now: number
): Promise<void> {
  try {
    const scans = await ledger.transfers.listScans(trade.id);
    for (const leg of [
      { side: "a", escrow: trade.escrowA, mint: trade.mintA },
      { side: "b", escrow: trade.escrowB, mint: trade.mintB },
    ] as const) {
      const scan = scans.find((entry) => entry.side === leg.side) ?? null;
      const due =
        changed ||
        scan === null ||
        scan.scannedAt === null ||
        Date.parse(scan.scannedAt) <= now - TRANSFER_RESCAN_MS;
      if (!due || ledger.budget.remaining <= 0) {
        continue;
      }
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- two legs, paced like every other read in the sweep.
      await syncDvpLegTransfers(
        ledger.reader,
        ledger.transfers,
        { tradeId: trade.id, createdAt: trade.createdAt, ...leg },
        scan,
        ledger.budget
      );
    }
  } catch (error) {
    getLogger().error(
      { tradeId: trade.id, error },
      "dvp reconcile: leg transfers could not be read; the next sweep asks again"
    );
  }
}

/**
 * Asks the chain what one chunk of expired receipts did, and deletes those that
 * moved nothing.
 *
 * A failed or short answer deletes nothing in the chunk: only a definitive
 * answer for a signature releases its claim, and the next tick asks again.
 */
async function resolveExpiredReceipts(
  claims: ReturnType<typeof createPostgresDvpLegFundingClaimRepository>,
  rpc: ReturnType<typeof createRpc>,
  chunk: readonly DvpLegFundingClaim[]
): Promise<void> {
  let statuses: Awaited<ReturnType<typeof getSignatureStatuses>>;
  try {
    const signatures = chunk.map((claim) => {
      assertIsSignature(claim.signature);
      return claim.signature;
    });
    statuses = await getSignatureStatuses(rpc, signatures, { searchTransactionHistory: true });
    // One answer owed per signature asked, in order. A short reply is a failed
    // read, never "not found", and a failed read never deletes.
    if (statuses.length !== chunk.length) {
      throw new Error(
        `getSignatureStatuses returned ${statuses.length} statuses for ${chunk.length} signatures`
      );
    }
  } catch (error) {
    getLogger().error(
      {
        event: "sdp_dvp_funding_claim_resolution_failed",
        claims: chunk.map((claim) => ({
          tradeId: claim.tradeId,
          side: claim.side,
          signature: claim.signature,
        })),
        error,
      },
      "dvp reconcile: expired broadcast funding claims could not be resolved"
    );
    return;
  }

  for (const [index, claim] of chunk.entries()) {
    const status = statuses[index] ?? null;
    // Two ways a transfer moved nothing: it never landed (null, and the query
    // only lists receipts already past their expiry height), or it landed and
    // FAILED (`err` set, fees consumed, zero tokens moved). Both leave the claim
    // neither lock nor receipt. The same classification decides whether reclaim
    // may take a receipt over.
    if (classifyDvpFundingReceipt(status, true) !== "moved_nothing") {
      continue;
    }
    try {
      // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each delete is guarded on its own signature; order does not matter and the count is bounded by the chunk.
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
    } catch (error) {
      getLogger().error(
        {
          event: "sdp_dvp_funding_claim_resolution_failed",
          tradeId: claim.tradeId,
          side: claim.side,
          signature: claim.signature,
          error,
        },
        "dvp reconcile: expired broadcast funding claim could not be released"
      );
    }
  }
}

async function reconcileTrade(
  repository: ReturnType<typeof createDvpTradeRepository>,
  ledger: TransferLedger,
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
    } else {
      // Capped or absent, the next lookup scans the same history again. An
      // absent close is usually history the RPC has not indexed yet, so it gets
      // the same growing wait rather than a full rescan every tick.
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
        { trade_id: trade.id, attempts, after, lookup: lookup.kind },
        "dvp reconcile: deferred close resolution"
      );
    }
  }

  const derived = deriveDvpTradeState(observation, trade, now);

  // Before the compare-and-swap below, which can lose to a fresher writer: the
  // escrow's history is the chain's, whoever recorded the status.
  const escrowAAmount = observation.legA.exists ? observation.legA.amount.toString() : null;
  const escrowBAmount = observation.legB.exists ? observation.legB.amount.toString() : null;
  await syncTradeTransfers(
    ledger,
    trade,
    derived.status !== trade.status ||
      escrowAAmount !== trade.escrowAAmount ||
      escrowBAmount !== trade.escrowBAmount,
    now
  );

  const updated = await repository.recordObservation({
    id: trade.id,
    // The status this derivation was computed from. A row something better
    // informed has already advanced makes this match nothing.
    expectedStatus: trade.status,
    status: derived.status,
    escrowAAmount,
    escrowBAmount,
    escrowAFrozen: observation.legA.exists ? observation.legA.frozen : null,
    escrowBFrozen: observation.legB.exists ? observation.legB.frozen : null,
    observedAt: new Date().toISOString(),
    observedClusterTimestamp: observation.clusterUnixTimestamp.toString(),
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
