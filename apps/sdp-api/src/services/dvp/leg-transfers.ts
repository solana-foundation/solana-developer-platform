/**
 * Reading a leg escrow's token movements off the chain (PRO-1941).
 *
 * Funding is a plain transfer anyone can send, and settle, cancel and reclaim
 * move tokens out, so no single signature SDP holds describes what a leg went
 * through. The escrow account's own history does. Each transaction that loaded
 * the escrow is read, and the change in the escrow's balance between its pre
 * and post token balances is the transfer: what SDP sent and what anybody else
 * sent come through the same read.
 *
 * Three rules settle what the ledger holds:
 *
 * - A transfer is recorded once its transaction is confirmed, provisional until
 *   it is seen finalized. The read position only moves over finalized
 *   signatures, so a provisional one is listed again on the next sweep, and a
 *   provisional row whose transaction the cluster no longer knows is deleted.
 *   The position also remembers whether the listing was seen to continue below
 *   its own slot: a short page that stops inside a slot can be a node caught
 *   mid-index, which lists the newest of two same-slot movements and omits the
 *   older, so the next read re-takes the whole overlap until the slot is
 *   proven and an omitted movement is never fenced out for good. A proven
 *   position is audited against the whole history on a clock of its own,
 *   because a node can also list straight past a hole it holds — only a walk
 *   from the top serves what a walk bounded at the position never lists again.
 * - History is read back no further than the trade's creation, less the clock
 *   skew the close lookup allows: an older transaction cannot concern this
 *   trade, even at a reused escrow address.
 * - Nothing guesses. A transaction whose balances cannot be read is logged and
 *   skipped, never recorded as zero, and a failed RPC read records nothing past
 *   it and leaves the read position where it was.
 */

import { withTransientRpcRetry } from "@sdp/rpc";
import { getSignatureStatuses, type SolanaRpc } from "@sdp/rpc/solana";
import {
  type Address,
  isAddress,
  isUnixTimestamp,
  type Signature,
  type Slot,
  signature,
  type UnixTimestamp,
  unixTimestamp,
} from "@solana/kit";
import { z } from "zod";
import type {
  DvpLegTransfer,
  DvpLegTransferRepository,
  DvpLegTransferScan,
  NewDvpLegTransfer,
} from "@/db/repositories/dvp-leg-transfer.repository";
import { getLogger } from "@/runtime/logger";
import { CREATE_TIME_SKEW_SECONDS } from "@/services/dvp/closing-transaction";

/** `getSignaturesForAddress` answers at most this many per page. */
export const HISTORY_PAGE_LIMIT = 1_000;
/**
 * Pages read back towards the last position before giving up for this sweep.
 * An escrow sees a handful of transactions in its life; thousands since the
 * last read is somebody spamming it, and is logged rather than chased. The
 * fallback's probe of the region behind the position reads at most this many
 * pages per sweep as well, and the scan remembers where it stopped, so however
 * deep the region runs, no sweep reads unboundedly far into it.
 */
const HISTORY_PAGE_CAP = 3;
/**
 * How long a proven read position is trusted as a bound before the escrow's
 * whole history is walked again. The proof is a listing that continued below
 * the position's slot, and a node can list past a hole it holds — an omitted
 * movement with newer ones listed above and older ones below — so the proof
 * ages out and the audit reads from the top, where the node serves what it
 * omitted once its index has caught up.
 */
export const HISTORY_AUDIT_MS = 60 * 60_000;
/** `getSignatureStatuses` answers at most this many signatures per call. */
const SIGNATURE_STATUS_LIMIT = 256;
/**
 * Signatures whose read outcome the process remembers. An escrow anyone may
 * send transactions to can collect thousands that moved none of its tokens,
 * and a region of the history full of them is re-listed by every probe until
 * it is walked through. Reading each one again every sweep would spend the
 * budget shared by every leg on answers already known, and stop the walk at
 * the same page each time; remembering the answer lets the walk pass a page
 * it has already read for the cost of the listing. Only the "moved nothing"
 * answer is remembered: it is read off the transaction the cluster served,
 * which never changes. A transaction whose balances could not be read with
 * confidence is forgotten on purpose — a caught-up node may serve it in a
 * shape the ledger can read, and a transfer sitting in it must stay
 * reachable, so it is read again and costs the budget once more. The cap
 * keeps a spammy escrow's whole history from being held in memory; an
 * evicted signature is read again, which costs a read and nothing else.
 */
const READ_MEMO_CAP = 20_000;

/**
 * How many unreadable reads one leg's scan remembers to ask for again. The
 * fallback's probe carries its resume point, so it lists each part of the
 * region behind the position once and never comes back: a transaction skipped
 * there is owed a read of its own, which the scan remembers across sweeps.
 * The cap keeps an escrow whose responses never read from owning an
 * unbounded share of the budget every sweep; past it, the oldest skips are
 * kept and the newest fall out, and an escrow that keeps sending such
 * responses is logged on every read anyway.
 */
const UNREADABLE_RETRY_CAP = 64;

/** One signature in an escrow's history, newest first as the cluster lists them. */
export interface DvpEscrowHistoryEntry {
  signature: Signature;
  slot: Slot;
  /** Null when the cluster recorded no time. */
  blockTime: UnixTimestamp | null;
  /** The transaction failed, so it moved no token. */
  failed: boolean;
  /** Finalized when listed. Anything less, including no status at all, is provisional. */
  finalized: boolean;
}

/** What the ledger asks the chain. Every method throws on a failed read. */
export interface DvpEscrowHistoryReader {
  /** One page of the escrow's history at confirmed, newest first, both bounds exclusive. */
  listSignatures(
    escrow: Address,
    page: { before: Signature | null; until: Signature | null }
  ): Promise<DvpEscrowHistoryEntry[]>;
  /** The transaction decoded at the boundary, or why it could not be. */
  readTransaction(signature: Signature): Promise<DvpLegTransactionRead>;
  /** Whether the cluster still knows each signature, in the order asked. */
  knowsSignatures(signatures: readonly Signature[]): Promise<boolean[]>;
  /** Whether the cluster has finalized each signature, in the order asked. */
  finalityOf(signatures: readonly Signature[]): Promise<boolean[]>;
  /**
   * The oldest slot this node still holds. Below it the node knows nothing, so
   * "not found" there is the node's gap, not a transaction that went away.
   */
  oldestKnownSlot(): Promise<bigint>;
}

const transactionErrorSchema = z.union([z.null(), z.string(), z.record(z.string(), z.unknown())]);

/** A block time as the cluster reports it, carried as Kit's branded timestamp. */
const unixTimestampSchema: z.ZodType<UnixTimestamp, unknown> = z
  .bigint()
  .refine(isUnixTimestamp, "not a Unix timestamp")
  .transform((value) => unixTimestamp(value));

const historyEntrySchema = z.object({
  signature: z.string(),
  slot: z.bigint(),
  blockTime: unixTimestampSchema.nullable(),
  err: transactionErrorSchema,
  confirmationStatus: z.enum(["processed", "confirmed", "finalized"]).nullable(),
});

/**
 * The chain behind the ledger, through the project's RPC.
 *
 * @param rpc - Solana RPC.
 */
export function createDvpEscrowHistoryReader(rpc: SolanaRpc): DvpEscrowHistoryReader {
  return {
    async listSignatures(escrow, page) {
      const response = await withTransientRpcRetry(() =>
        rpc
          .getSignaturesForAddress(escrow, {
            limit: HISTORY_PAGE_LIMIT,
            commitment: "confirmed",
            before: page.before ?? undefined,
            until: page.until ?? undefined,
          })
          .send()
      );
      return z
        .array(historyEntrySchema)
        .parse(response)
        .map((entry) => ({
          signature: signature(entry.signature),
          slot: entry.slot,
          blockTime: entry.blockTime,
          failed: entry.err !== null,
          finalized: entry.confirmationStatus === "finalized",
        }));
    },

    async readTransaction(transactionSignature) {
      const response = await withTransientRpcRetry(() =>
        rpc
          .getTransaction(transactionSignature, {
            commitment: "confirmed",
            encoding: "jsonParsed",
            maxSupportedTransactionVersion: 0,
          })
          .send()
      );
      return parseDvpLegTransaction(response);
    },

    async knowsSignatures(signatures) {
      const statuses = await getSignatureStatuses(rpc, [...signatures], {
        searchTransactionHistory: true,
      });
      // One answer owed per signature, in order. A short reply is a failed read,
      // never "not found", and a failed read never deletes.
      if (statuses.length !== signatures.length) {
        throw new Error(
          `getSignatureStatuses returned ${statuses.length} statuses for ${signatures.length} signatures`
        );
      }
      return statuses.map((status) => status !== null);
    },

    async finalityOf(signatures) {
      const statuses = await getSignatureStatuses(rpc, [...signatures], {
        searchTransactionHistory: true,
      });
      if (statuses.length !== signatures.length) {
        throw new Error(
          `getSignatureStatuses returned ${statuses.length} statuses for ${signatures.length} signatures`
        );
      }
      return statuses.map((status) => status?.confirmationStatus === "finalized");
    },

    async oldestKnownSlot() {
      return await withTransientRpcRetry(() => rpc.getFirstAvailableBlock().send());
    },
  };
}

/** The escrow a leg's history is read for. */
export interface DvpLegEscrow {
  tradeId: string;
  side: "a" | "b";
  escrow: Address;
  mint: Address;
  /** The trade row's creation time. History is not read back past it. */
  createdAt: string;
}

const tokenBalanceSchema = z.object({
  accountIndex: z.number().int().nonnegative(),
  mint: z.string(),
  uiTokenAmount: z.object({ amount: z.string() }),
});

/** The part of a `jsonParsed` transaction the delta is read from. */
export interface DvpLegTransaction {
  slot: Slot;
  blockTime: UnixTimestamp | null;
  meta: {
    err: z.infer<typeof transactionErrorSchema>;
    preTokenBalances?: z.infer<typeof tokenBalanceSchema>[];
    postTokenBalances?: z.infer<typeof tokenBalanceSchema>[];
  } | null;
  transaction: { message: { accountKeys: { pubkey: string }[] } };
}

const legTransactionSchema: z.ZodType<DvpLegTransaction, unknown> = z.object({
  slot: z.bigint(),
  blockTime: unixTimestampSchema.nullable(),
  meta: z
    .object({
      err: transactionErrorSchema,
      preTokenBalances: z.array(tokenBalanceSchema).optional(),
      postTokenBalances: z.array(tokenBalanceSchema).optional(),
    })
    .nullable(),
  transaction: z.object({
    message: z.object({ accountKeys: z.array(z.object({ pubkey: z.string() })) }),
  }),
});

/** A transaction read off the cluster, decoded at the boundary. */
export type DvpLegTransactionRead =
  | { kind: "read"; transaction: DvpLegTransaction }
  /** Listed, but not served at confirmed yet. Not a transaction that moved nothing. */
  | { kind: "not_served" }
  /** Served, but not in a shape the ledger can read with confidence. */
  | { kind: "malformed"; reason: string };

/**
 * Decodes a `getTransaction` response at the RPC boundary.
 *
 * @param response - The response as the RPC returned it.
 */
export function parseDvpLegTransaction(response: unknown): DvpLegTransactionRead {
  if (response === null) {
    return { kind: "not_served" };
  }
  const parsed = legTransactionSchema.safeParse(response);
  return parsed.success
    ? { kind: "read", transaction: parsed.data }
    : { kind: "malformed", reason: "the transaction does not have the expected shape" };
}

export type DvpLegTransferReading =
  | { kind: "transfer"; transfer: NewDvpLegTransfer }
  /** The transaction loaded the escrow and moved none of its tokens. */
  | { kind: "none" }
  /** The balances could not be read with confidence; `reason` says why. */
  | { kind: "unreadable"; reason: string };

const BASE_UNITS = /^\d+$/;

/**
 * The escrow's balance change in one transaction.
 *
 * A token balance missing from one side of a transaction that lists it on the
 * other is zero on the missing side: the account was created in that
 * transaction (no pre balance) or closed in it (no post balance, and a token
 * account only closes empty). Missing from both, the transaction moved none of
 * its tokens. Anything else that does not add up is unreadable, never zero.
 *
 * @param transactionSignature - The transaction's signature.
 * @param transaction - The transaction, decoded.
 * @param leg - The escrow and its mint.
 * @param finalized - Whether the transaction was finalized when listed.
 */
export function readDvpLegTransfer(
  transactionSignature: Signature,
  { meta, transaction, slot, blockTime }: DvpLegTransaction,
  leg: Pick<DvpLegEscrow, "tradeId" | "side" | "escrow" | "mint">,
  finalized: boolean
): DvpLegTransferReading {
  if (meta === null) {
    return { kind: "unreadable", reason: "the transaction carries no status metadata" };
  }
  // A failed transaction is atomic: fees were charged and no token moved.
  if (meta.err !== null) {
    return { kind: "none" };
  }
  if (meta.preTokenBalances === undefined || meta.postTokenBalances === undefined) {
    return { kind: "unreadable", reason: "the transaction carries no token balances" };
  }
  const { accountKeys } = transaction.message;
  const index = accountKeys.findIndex((key) => key.pubkey === leg.escrow);
  if (index === -1) {
    return { kind: "unreadable", reason: "the escrow is not among the transaction's accounts" };
  }
  const feePayer = accountKeys[0]?.pubkey;
  if (feePayer === undefined || !isAddress(feePayer)) {
    return { kind: "unreadable", reason: "the transaction names no readable fee payer" };
  }

  const pre = meta.preTokenBalances.find((balance) => balance.accountIndex === index);
  const post = meta.postTokenBalances.find((balance) => balance.accountIndex === index);
  if (pre === undefined && post === undefined) {
    return { kind: "none" };
  }
  for (const balance of [pre, post]) {
    if (balance === undefined) {
      continue;
    }
    if (balance.mint !== leg.mint) {
      return { kind: "unreadable", reason: `the escrow holds mint ${balance.mint}, not the leg's` };
    }
    if (!BASE_UNITS.test(balance.uiTokenAmount.amount)) {
      return { kind: "unreadable", reason: "the escrow's balance is not a base-unit integer" };
    }
  }

  const before = pre === undefined ? 0n : BigInt(pre.uiTokenAmount.amount);
  const after = post === undefined ? 0n : BigInt(post.uiTokenAmount.amount);
  const delta = after - before;
  if (delta === 0n) {
    return { kind: "none" };
  }
  return {
    kind: "transfer",
    transfer: {
      tradeId: leg.tradeId,
      side: leg.side,
      signature: transactionSignature,
      direction: delta > 0n ? "in" : "out",
      amount: (delta > 0n ? delta : -delta).toString(),
      slot: slot.toString(),
      blockTime: blockTime === null ? null : blockTime.toString(),
      feePayer,
      finalized,
    },
  };
}

/** Transactions this sweep may still read, shared by every leg in it. */
export interface DvpLegTransferBudget {
  remaining: number;
}

/**
 * What reading a transaction came to, for the signatures whose answer never
 * changes: it moved none of the escrow's tokens. The answer is read off the
 * transaction the cluster served, which is fixed once served, so it is the
 * same every time the signature is listed, and a re-listed page is resolved
 * from the memo without spending the sweep's budget on the read again. An
 * unreadable read is deliberately not one of these: it says the balances
 * could not be read with confidence, not what the transaction did, and stays
 * retryable.
 */
export type DvpLegTransferReadOutcome = { kind: "none" };

/** The leg a read outcome belongs to: the balances that were evaluated. */
export type DvpLegTransferReadScope = Pick<DvpLegEscrow, "escrow" | "mint">;

/** Signatures whose read outcome this process already knows, per leg. */
export interface DvpLegTransferReadMemo {
  /** The outcome the signature was read to for this leg, or null for one never read. */
  recall(leg: DvpLegTransferReadScope, signature: Signature): DvpLegTransferReadOutcome | null;
  remember(
    leg: DvpLegTransferReadScope,
    signature: Signature,
    outcome: DvpLegTransferReadOutcome
  ): void;
}

/**
 * A bounded memo of read outcomes, shared by every leg in the process and
 * scoped to the leg whose balances each outcome was read from: one
 * transaction can sit in two escrows' histories and move one while moving
 * none of the other, so an answer recorded for one leg must never be served
 * to another. The oldest entry falls out of the memo past the cap, and a
 * recalled one is moved to the newest end so a region the sweep walks
 * repeatedly stays in it.
 */
export function createDvpLegTransferReadMemo(cap: number = READ_MEMO_CAP): DvpLegTransferReadMemo {
  const outcomes = new Map<string, DvpLegTransferReadOutcome>();
  const key = (leg: DvpLegTransferReadScope, signature: Signature) =>
    `${leg.escrow}:${leg.mint}:${signature}`;
  return {
    recall(leg, signature) {
      const memoKey = key(leg, signature);
      const outcome = outcomes.get(memoKey);
      if (outcome === undefined) {
        return null;
      }
      outcomes.delete(memoKey);
      outcomes.set(memoKey, outcome);
      return outcome;
    },
    remember(leg, signature, outcome) {
      const memoKey = key(leg, signature);
      outcomes.delete(memoKey);
      outcomes.set(memoKey, outcome);
      const oldest = outcomes.keys().next().value;
      if (outcomes.size > cap && oldest !== undefined) {
        outcomes.delete(oldest);
      }
    },
  };
}

/** The earliest block time, in Unix seconds, a transaction for this trade can carry. */
function historyFloor(leg: DvpLegEscrow): bigint {
  const createdAtMs = Date.parse(leg.createdAt);
  if (Number.isNaN(createdAtMs)) {
    throw new Error(`trade ${leg.tradeId} has an unreadable created_at`);
  }
  return BigInt(Math.floor(createdAtMs / 1000) - CREATE_TIME_SKEW_SECONDS);
}

/**
 * The escrow's history after `until`, newest first, back no further than the
 * trade's creation. `floorReached` says whether the listing ran past that
 * creation: the read then saw depth below every slot it lists, which is proof
 * no later read has to see again. `complete` says whether the walk reached its
 * end — the bound, the floor, or the node running out of history. A walk the
 * page cap cut off returns what it saw with `complete` false, since resolving
 * the oldest of a truncated read would leave a gap behind it no later read
 * fills. `from` starts the walk below a signature instead of at the top,
 * which is how a bounded read reaches the region its bound excludes.
 * `pageCap` is how many pages the walk may read before giving up for this
 * sweep; the probe of the region behind the read position gets the same cap,
 * and the scan carries where it stopped, so the next sweep's probe resumes
 * below that instead of starting over.
 */
async function readHistorySince(
  reader: DvpEscrowHistoryReader,
  leg: DvpLegEscrow,
  until: Signature | null,
  from: Signature | null = null,
  pageCap: number = HISTORY_PAGE_CAP
): Promise<{ entries: DvpEscrowHistoryEntry[]; floorReached: boolean; complete: boolean }> {
  const floor = historyFloor(leg);
  const newestFirst: DvpEscrowHistoryEntry[] = [];
  let before: Signature | null = from;
  for (let page = 0; page < pageCap; page += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each page starts where the previous one ended.
    const entries = await reader.listSignatures(leg.escrow, { before, until });
    for (const entry of entries) {
      // Newest first, so everything after this one is older still.
      if (entry.blockTime !== null && entry.blockTime < floor) {
        return { entries: newestFirst, floorReached: true, complete: true };
      }
      newestFirst.push(entry);
    }
    const oldest = entries.at(-1);
    if (entries.length < HISTORY_PAGE_LIMIT || oldest === undefined) {
      return { entries: newestFirst, floorReached: false, complete: true };
    }
    before = oldest.signature;
  }
  return { entries: newestFirst, floorReached: false, complete: false };
}

/**
 * The one listing a walk the page cap cut off would resolve nothing from:
 * its oldest entry leaves a gap behind it no later read fills. Null unless
 * the walk reached its end.
 */
function listed(read: {
  entries: DvpEscrowHistoryEntry[];
  floorReached: boolean;
  complete: boolean;
}): { entries: DvpEscrowHistoryEntry[]; floorReached: boolean } | null {
  return read.complete ? read : null;
}

/**
 * Why a signature stopped the walk: the sweep's budget ran out, which ends
 * the walk outright, or the node would not serve the transaction, which the
 * region behind the cursor reads past.
 */
type EntryStop = "budget" | "unread";

/**
 * Whether a stopped signature ends the walk: a budget stop does, and so does
 * one in the read the position advances over — the position never moves past
 * an unresolved signature. Behind the cursor a transaction the node will not
 * serve stops only itself: the probe records what it can and reads on.
 */
function endsTheWalk(reason: EntryStop, mayAdvance: boolean): boolean {
  return reason === "budget" || mayAdvance;
}

/**
 * Reads a leg's escrow history on from a saved cursor after the walk from
 * the top ran past the scan cap: the signatures newer than the cursor, and the
 * region below it as well, because that is where the node's omission sits —
 * an omitted movement is served there once the node's index catches up, and a
 * walk bounded at the cursor alone would never list it. The two regions are
 * listings of their own: `bounded` counts the entries the bounded read saw,
 * so the sweep can tell them apart, and the probe's depth proves nothing
 * about the bounded read above the cursor.
 *
 * The probe reads at most the scan cap's pages below where the last probe
 * stopped — behind the position when no probe point is saved. An escrow that
 * keeps receiving ordinary transfers can hold a region deeper than any one
 * sweep should list, and reading it all before the sweep's transaction budget
 * even applies would be arbitrarily many sequential RPC requests holding
 * arbitrarily many entries in memory, delaying every other trade in the
 * batch. The sweep therefore saves where the probe stopped, and the next
 * sweep's probe resumes below that: the region's oldest end is reached a few
 * pages further down with every sweep, and a probe that runs to its end — a
 * short page or history past the trade's creation — has covered the whole
 * region, so the point is dropped and the next one starts behind the position
 * again. `probeComplete` says whether this probe ran to its end, and
 * `probeDeepest` is the signature below which it stopped.
 *
 * When the bounded read was itself cut off by the cap, it listed only the
 * newest of the region above the cursor, and the part it never listed sits
 * between the cursor and the deepest signature it listed. That region is read
 * here as well, its own listing bounded by the same cap: a resume point saved
 * below the cursor would start the next probe past it, so the point may only
 * travel below the cursor once this read has listed the region through.
 * `gapComplete` says whether it did, and `gapDeepest` is the signature below
 * which it stopped otherwise.
 *
 * @param reader - The chain.
 * @param leg - The escrow to read.
 * @param cursor - The saved read position to read on from.
 * @param probe - Where the last probe stopped, or null to probe from the cursor.
 */
async function readOnPastCap(
  reader: DvpEscrowHistoryReader,
  leg: DvpLegEscrow,
  cursor: { signature: Signature; slot: string },
  probe: { signature: Signature; slot: string } | null
): Promise<{
  read: { entries: DvpEscrowHistoryEntry[]; floorReached: boolean };
  bounded: number;
  chunked: boolean;
  probeComplete: boolean;
  probeDeepest: { signature: Signature; slot: string } | null;
  gapComplete: boolean;
  gapDeepest: { signature: Signature; slot: string } | null;
}> {
  const newer = await readHistorySince(reader, leg, cursor.signature);
  // A read the cap cut off is kept whole: every signature it listed is
  // resolved, and the position it offers the walk stands at the deepest of
  // them, so nothing the read saw is thrown away and nothing it skipped sits
  // further behind the position than the next sweep's probe reaches.
  const chunked = !newer.complete;
  const boundedNewestFirst = newer.entries;
  // The part of the region above the cursor the bounded read never listed:
  // empty and complete when the read was not cut off, since a read that ran
  // to its end listed everything above the cursor there is.
  let gapNewestFirst: DvpEscrowHistoryEntry[] = [];
  let gapComplete = true;
  const boundedOldest = boundedNewestFirst.at(-1);
  if (chunked && boundedOldest !== undefined) {
    const gap = await readHistorySince(
      reader,
      leg,
      cursor.signature,
      boundedOldest.signature,
      HISTORY_PAGE_CAP
    );
    gapNewestFirst = gap.entries;
    gapComplete = gap.complete;
  }
  // The probe starts below where the last one stopped, or immediately behind
  // the cursor, and reads at most the scan cap's pages: the region behind the
  // position the sweep is about to save is the one read only the probe
  // reaches, and it is covered a few pages further down with every sweep.
  const older = await readHistorySince(
    reader,
    leg,
    null,
    probe?.signature ?? cursor.signature,
    HISTORY_PAGE_CAP
  );
  const deepest = older.entries.at(-1);
  const gapOldest = gapNewestFirst.at(-1);
  return {
    read: {
      // Newest first, so the region below the cursor follows the region above
      // it. The floor is the bounded read's own: the probe may have run past
      // the trade's creation, but that is depth below the cursor, not proof
      // of what the bounded read listed above it.
      entries: [...boundedNewestFirst, ...gapNewestFirst, ...older.entries],
      floorReached: newer.floorReached,
    },
    bounded: boundedNewestFirst.length,
    chunked,
    probeComplete: older.complete,
    // A probe the cap cut off always listed at least one full page, so the
    // only way to stop below nothing is a probe that ran to its end — where
    // the point is dropped and null is the right answer anyway.
    probeDeepest:
      deepest === undefined
        ? null
        : { signature: deepest.signature, slot: deepest.slot.toString() },
    gapComplete,
    gapDeepest:
      gapOldest === undefined
        ? null
        : { signature: gapOldest.signature, slot: gapOldest.slot.toString() },
  };
}

/**
 * The watermark for the position's new slot: a move within the slot the
 * position already sits on keeps that slot's proof, and any other advance is
 * proven only by the listing continuing below the new slot — an entry at an
 * earlier slot, or history past the trade's creation.
 */
function watermarkFor(
  cursor: { signature: Signature; slot: string } | null,
  cursorSlotComplete: boolean,
  slot: string,
  floorReached: boolean,
  newestFirst: readonly DvpEscrowHistoryEntry[]
): boolean {
  return (
    (cursor !== null && cursor.slot === slot && cursorSlotComplete) ||
    floorReached ||
    // Slots are numbers the ledger carries as strings; the comparison is the
    // numeric one the repository's own guard makes.
    newestFirst.some((listed) => BigInt(listed.slot) < BigInt(slot))
  );
}

/**
 * The position over a resolved, finalized entry: forward onto it when the
 * entry is one the read may advance over — the probe's findings behind the
 * cursor never are — and the move would not be backward, with the watermark
 * qualifying the new position; the position and its watermark as they were
 * otherwise. The PostgreSQL repository would refuse a backward write in any
 * case, and a same-slot step back is one its guard could not tell from a
 * step forward, so the service keeps the position where it was.
 */
function advancedPosition(
  cursor: { signature: Signature; slot: string } | null,
  cursorSlotComplete: boolean,
  entry: DvpEscrowHistoryEntry,
  mayAdvance: boolean,
  floorReached: boolean,
  evidence: readonly DvpEscrowHistoryEntry[]
): {
  cursor: { signature: Signature; slot: string } | null;
  cursorSlotComplete: boolean;
} {
  const slot = entry.slot.toString();
  if (!mayAdvance || (cursor !== null && BigInt(slot) < BigInt(cursor.slot))) {
    return { cursor, cursorSlotComplete };
  }
  return {
    cursor: { signature: entry.signature, slot },
    cursorSlotComplete: watermarkFor(cursor, cursorSlotComplete, slot, floorReached, evidence),
  };
}

/**
 * Resolves one listed signature: recorded, moving nothing, or unreadable and
 * logged. A read whose balances could not be read with confidence is appended
 * to `unreadableSkips` when the caller collects them, since a walk never lists
 * behind the position again and the transaction is owed a read of its own.
 */
async function resolveEntry(
  reader: DvpEscrowHistoryReader,
  transfers: DvpLegTransferRepository,
  leg: DvpLegEscrow,
  entry: DvpEscrowHistoryEntry,
  known: ReadonlyMap<Signature, DvpLegTransfer>,
  budget: DvpLegTransferBudget,
  memo: DvpLegTransferReadMemo,
  unreadableSkips?: DvpEscrowHistoryEntry[]
): Promise<{ step: "resolved"; recorded: boolean } | { step: "stop"; reason: EntryStop }> {
  // A transaction that failed moved no token; no need to read it.
  if (entry.failed) {
    return { step: "resolved", recorded: false };
  }
  const existing = known.get(entry.signature);
  if (existing !== undefined) {
    // Already read off this transaction. All that can change is its finality.
    if (entry.finalized && !existing.finalized) {
      await transfers.markFinalized(leg.tradeId, leg.side, entry.signature);
    }
    return { step: "resolved", recorded: false };
  }
  // A transaction read before this process was asked about it again, for
  // this leg: it moved none of this escrow's tokens, and that answer never
  // changes, so it is resolved for the cost of the listing and the sweep's
  // budget is spent only on reads that could still record something.
  const remembered = memo.recall(leg, entry.signature);
  if (remembered !== null) {
    return { step: "resolved", recorded: false };
  }
  if (budget.remaining <= 0) {
    return { step: "stop", reason: "budget" };
  }
  budget.remaining -= 1;
  let read: DvpLegTransactionRead;
  try {
    read = await reader.readTransaction(entry.signature);
  } catch (error) {
    getLogger().error(
      { error, tradeId: leg.tradeId, side: leg.side, signature: entry.signature },
      "dvp transfers: transaction could not be read; the next sweep asks again"
    );
    return { step: "stop", reason: "unread" };
  }
  if (read.kind === "not_served") {
    return { step: "stop", reason: "unread" };
  }
  const reading =
    read.kind === "malformed"
      ? { kind: "unreadable" as const, reason: read.reason }
      : readDvpLegTransfer(entry.signature, read.transaction, leg, entry.finalized);
  if (reading.kind === "unreadable") {
    getLogger().error(
      {
        event: "sdp_dvp_leg_transfer_unreadable",
        tradeId: leg.tradeId,
        side: leg.side,
        signature: entry.signature,
        reason: reading.reason,
      },
      "dvp transfers: skipped a transaction whose escrow balances could not be read"
    );
    // Deliberately not remembered: an unreadable answer says the balances
    // could not be read with confidence, not what the transaction did, and a
    // caught-up node may yet serve it in a shape the ledger can read. It
    // costs the budget again next sweep, and a transfer sitting in it stays
    // reachable.
    unreadableSkips?.push(entry);
    return { step: "resolved", recorded: false };
  }
  if (reading.kind === "none") {
    memo.remember(leg, entry.signature, { kind: "none" });
    return { step: "resolved", recorded: false };
  }
  await transfers.record(reading.transfer);
  return { step: "resolved", recorded: true };
}

/**
 * Asks the chain again for each transaction the last sweeps could not read
 * with confidence, oldest first, out of the sweep's own budget. A read that
 * comes back in a shape the ledger can read records the transfer (or settles
 * that the transaction moved none of the escrow's tokens), and the entry
 * leaves the list; anything else -- including a budget that ran out before
 * the read -- keeps it there for the next sweep. The asks may spend at most
 * half of what the sweep has left, so however long they go on, the newly
 * listed movements of this sweep keep their share of the budget.
 *
 * Each ask is replayed with the finality the cluster reports now, not the one
 * the listing carried when the read was skipped: a transaction confirmed then
 * and finalized since is recorded finalized, and never waits for a listing of
 * the older region to settle its row.
 *
 * @returns The retries still owed after this sweep's asks.
 */
async function retryUnreadableReads(
  reader: DvpEscrowHistoryReader,
  transfers: DvpLegTransferRepository,
  leg: DvpLegEscrow,
  retries: DvpLegTransferScan["unreadableRetries"] | undefined,
  known: ReadonlyMap<Signature, DvpLegTransfer>,
  budget: DvpLegTransferBudget,
  memo: DvpLegTransferReadMemo
): Promise<DvpLegTransferScan["unreadableRetries"]> {
  const owed = retries ?? [];
  if (owed.length === 0) {
    return [];
  }
  const kept: DvpLegTransferScan["unreadableRetries"] = [];
  // Half of what the sweep has left, rounded up: the first ask may spend it
  // all, and the walk that follows still holds the other half.
  const share = Math.ceil(budget.remaining / 2);
  let spent = 0;
  let finalized: boolean[];
  try {
    finalized = await reader.finalityOf(owed.map((retry) => retry.signature));
  } catch (error) {
    getLogger().error(
      { error, tradeId: leg.tradeId, side: leg.side, signatures: owed.map((r) => r.signature) },
      "dvp transfers: could not ask how far the cluster has finalized the owed reads"
    );
    // The status read failing does not stop the asks: each one is replayed
    // with the finality its listing carried, and a transaction finalized
    // since is settled by a later sweep's ask, whose status read succeeds.
    finalized = [];
  }
  for (const [index, retry] of owed.entries()) {
    if (budget.remaining <= 0 || spent >= share) {
      kept.push(retry);
      continue;
    }
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each ask is guarded on its own signature; the list is bounded by the retry cap.
    const skipped: DvpEscrowHistoryEntry[] = [];
    const before = budget.remaining;
    const outcome = await resolveEntry(
      reader,
      transfers,
      leg,
      {
        signature: retry.signature,
        slot: BigInt(retry.slot),
        blockTime: null,
        failed: false,
        finalized: finalized[index] ?? retry.finalized,
      },
      known,
      budget,
      memo,
      skipped
    );
    spent += before - budget.remaining;
    if (outcome.step === "stop" || skipped.length > 0) {
      // The cluster would not serve it, the read failed, the budget ran out,
      // or the balances came back unreadable again: the ask stays owed.
      kept.push(retry);
    }
  }
  return kept;
}

/**
 * The retry list the sweep hands over: the asks it did not settle, and the
 * unreadable skips of this sweep's own walk that stand behind the position it
 * saves -- the walk never lists behind the position again, so those are owed
 * a read of their own. Skips above the position are left out, since the
 * bounded read lists everything newer than the position again, and the list
 * keeps the oldest entries past the cap.
 */
function nextUnreadableRetries(
  kept: DvpLegTransferScan["unreadableRetries"],
  skipped: readonly DvpEscrowHistoryEntry[],
  cursor: { signature: Signature; slot: string } | null
): { retries: DvpLegTransferScan["unreadableRetries"]; overflowed: boolean } {
  if (cursor === null) {
    // No position at all: the sweep reads the whole history from the top, so
    // every one of these transactions is listed again regardless.
    return { retries: [], overflowed: false };
  }
  const entries = [...kept];
  const seen = new Set(entries.map((retry) => retry.signature));
  for (const entry of skipped) {
    if (seen.has(entry.signature)) {
      continue;
    }
    if (BigInt(entry.slot) > BigInt(cursor.slot)) {
      // Above the position: the bounded read lists everything newer than the
      // position again, so this one is asked about regardless.
      continue;
    }
    seen.add(entry.signature);
    entries.push({
      signature: entry.signature,
      slot: entry.slot.toString(),
      finalized: entry.finalized,
    });
  }
  // Past the cap the newest asks fall out of the list, and the probe's resume
  // point falls with them: the next sweep probes from the position again,
  // where the transactions it dropped are listed and collected once more.
  return {
    retries: entries.slice(0, UNREADABLE_RETRY_CAP),
    overflowed: entries.length > UNREADABLE_RETRY_CAP,
  };
}

/**
 * Deletes provisional rows whose transaction the chain no longer knows.
 *
 * A provisional row always sits past the read position, so a complete listing
 * that lacks it has either lost it or come from a node that has not caught up.
 * The status lookup tells the two apart, and only a definitive "not found"
 * deletes: a failed lookup deletes nothing, and neither does a row older than
 * the node's own history, where "not found" only means the node cannot see
 * that far back. Deleting on that answer would drop a transfer that happened,
 * and nothing later would bring it back, because the read position has moved
 * past it.
 *
 * @returns How many provisional rows are still unaccounted for.
 */
async function removeDroppedTransfers(
  reader: DvpEscrowHistoryReader,
  transfers: DvpLegTransferRepository,
  leg: DvpLegEscrow,
  known: ReadonlyMap<Signature, DvpLegTransfer>,
  listed: ReadonlySet<Signature>
): Promise<number> {
  const unlisted = [...known.values()]
    .filter((transfer) => !transfer.finalized && !listed.has(transfer.signature))
    .map((transfer) => transfer.signature);
  if (unlisted.length === 0) {
    return 0;
  }
  const asked = unlisted.slice(0, SIGNATURE_STATUS_LIMIT);
  let knows: boolean[];
  try {
    knows = await reader.knowsSignatures(asked);
  } catch (error) {
    getLogger().error(
      { error, tradeId: leg.tradeId, side: leg.side, signatures: asked },
      "dvp transfers: could not ask whether unlisted provisional transfers still exist"
    );
    return unlisted.length;
  }
  let oldestKnownSlot: bigint;
  try {
    oldestKnownSlot = await reader.oldestKnownSlot();
  } catch (error) {
    getLogger().error(
      { error, tradeId: leg.tradeId, side: leg.side },
      "dvp transfers: could not read how far back the node's history goes; nothing removed"
    );
    return unlisted.length;
  }

  let remaining = unlisted.length - asked.length;
  for (const [index, dropped] of asked.entries()) {
    if (knows[index] === true) {
      remaining += 1;
      continue;
    }
    const row = known.get(dropped);
    if (row !== undefined && BigInt(row.slot) < oldestKnownSlot) {
      // The node's history starts after this transfer. Its silence says nothing.
      remaining += 1;
      getLogger().warn(
        {
          event: "sdp_dvp_leg_transfer_unprovable",
          tradeId: leg.tradeId,
          side: leg.side,
          signature: dropped,
          slot: row.slot,
          oldestKnownSlot: oldestKnownSlot.toString(),
        },
        "dvp transfers: kept a provisional transfer the node cannot answer for"
      );
      continue;
    }
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each delete is guarded on its own signature and provisional state; bounded by the status limit.
    await transfers.deleteProvisional(leg.tradeId, leg.side, dropped);
    getLogger().warn(
      {
        event: "sdp_dvp_leg_transfer_dropped",
        tradeId: leg.tradeId,
        side: leg.side,
        signature: dropped,
      },
      "dvp transfers: removed a confirmed transfer whose transaction the cluster dropped"
    );
  }
  return remaining;
}

/**
 * The bound the stored cursor offers this sweep. A cursor is a safe `until`
 * only when the read that reached it saw the listing continue below its slot:
 * a page that stops inside the cursor's own slot can be a node caught
 * mid-index, one that listed the newest of two same-slot movements and omitted
 * the older — and a later read bounded at the cursor would never be offered it
 * again. An unproven cursor is not trusted as a bound: the read takes the
 * whole overlap from the top, where the omission can still surface. A proven
 * cursor is trusted only until the audit falls due, for the same reason: the
 * node that proved the slot could have been listing straight past a hole it
 * holds, and only an unbounded walk serves what a bounded one never lists
 * again.
 */
function historyBound(scan: SeenScan | null, now: number): Signature | null {
  if (scan?.cursorSlotComplete !== true) {
    return null;
  }
  const scannedAt = scan.scannedAt;
  if (
    scannedAt !== null &&
    Math.floor(Date.parse(scannedAt) / HISTORY_AUDIT_MS) < Math.floor(now / HISTORY_AUDIT_MS)
  ) {
    return null;
  }
  return scan.cursor?.signature ?? null;
}

/**
 * What the sweep reads: the walk from the top when it fits under the scan
 * cap, or — when the walk ran past the cap and the leg has a saved cursor to
 * read on from — the fallback's stitch of the region above the cursor, the
 * part of that region the bounded read never listed, and the probe of the
 * region below it, resuming behind where the last probe stopped.
 *
 * A walk that ran past the scan cap is dropped whole on its own: resolving
 * the oldest of a truncated read would leave a gap behind it no later read
 * fills. Giving up entirely would stall the leg on a read it can never finish
 * — an unproven cursor un-bounds every later sweep too — so the saved cursor,
 * the bound this leg read behind before the watermark existed, is where the
 * sweep reads on from, and the region below it is probed, keeping what the
 * probe saw: that is where the node's omission sits. The probe never moves
 * the position nor proves it, and the watermark keeps the next sweep asking
 * for the whole history; the audit keeps that ask alive for a proven one.
 */
async function readTheSweep(
  reader: DvpEscrowHistoryReader,
  leg: DvpLegEscrow,
  since: Signature | null,
  stored: { signature: Signature; slot: string } | null,
  probe: { signature: Signature; slot: string } | null
): Promise<{
  read: { entries: DvpEscrowHistoryEntry[]; floorReached: boolean } | null;
  bounded: number | null;
  chunked: boolean;
  probeComplete: boolean;
  probeDeepest: { signature: Signature; slot: string } | null;
  gapComplete: boolean;
  gapDeepest: { signature: Signature; slot: string } | null;
}> {
  const read = listed(await readHistorySince(reader, leg, since));
  if (read !== null || stored === null || since !== null) {
    return {
      read,
      bounded: null,
      chunked: false,
      probeComplete: true,
      probeDeepest: null,
      gapComplete: true,
      gapDeepest: null,
    };
  }
  getLogger().warn(
    { tradeId: leg.tradeId, side: leg.side, escrow: leg.escrow },
    "dvp transfers: escrow history from the top exceeds the scan cap; reading on from the saved cursor"
  );
  const fallback = await readOnPastCap(reader, leg, stored, probe);
  return {
    read: fallback.read,
    bounded: fallback.bounded,
    chunked: fallback.chunked,
    probeComplete: fallback.probeComplete,
    probeDeepest: fallback.probeDeepest,
    gapComplete: fallback.gapComplete,
    gapDeepest: fallback.gapDeepest,
  };
}

/**
 * Whether the position's proof survives the sweep: the watermark it arrived
 * with, the walk got through the region behind the cursor, the read was not
 * cut off above the position, and the probe's listing ran to its end. The
 * region behind the position is only accounted for when all of those hold,
 * and a position whose behind is unaccounted for is never a safe bound. No
 * position at all is never proven.
 */
function provenPosition(
  cursor: { signature: Signature; slot: string } | null,
  watermark: boolean,
  probeEnded: boolean,
  chunked: boolean,
  probeComplete: boolean
): boolean {
  return cursor !== null && watermark && probeEnded && !chunked && probeComplete;
}

/**
 * Whether the sweep counts as a scan: the read got through to the newest
 * signature with nothing left provisional, nothing skipped in the middle, and
 * the probe of the region behind the position ran to its end. Anything less
 * leaves the leg due next sweep.
 */
function settledRead(
  complete: boolean,
  finalizedSoFar: boolean,
  unaccounted: number,
  chunked: boolean,
  probeComplete: boolean
): boolean {
  return complete && finalizedSoFar && unaccounted === 0 && !chunked && probeComplete;
}

/**
 * Whether the position was stood at the deepest signature a chunked read
 * listed: the region immediately behind it — the part of the region above the
 * cursor that read never listed — is only accounted for once the sweep's own
 * read of it ran through, and until then no point below the cursor may
 * travel with the position.
 */
function standsBeforeAnUnlistedRegion(chunked: boolean, deepestReached: boolean): boolean {
  return chunked && deepestReached;
}

/**
 * Where the next sweep's probe of the region behind the position resumes. A
 * probe the cap stopped saves the signature below which it stopped, so the
 * region's oldest end is reached a few pages further down with every sweep;
 * a probe that ran to its end covered the whole region, so the next one
 * starts over from the position. An interrupted walk through the probe's
 * finds saves nothing: the finds above the deepest page were never resolved,
 * and a resume point below them would leave them skipped.
 *
 * When the sweep stood the position at the deepest signature a chunked read
 * listed, the region behind that position — down to the cursor the probe
 * probed below — is the part of the region above the cursor the bounded read
 * never listed. A point below the cursor would start the next probe past it,
 * so the point may only travel below the cursor once this sweep's read of
 * that region ran through: the probe's own point then stands, and the next
 * probe resumes below it rather than behind the position, keeping the depth
 * past sweeps reached however much newer history the escrow keeps
 * accumulating. A gap read the cap stopped saves where it stopped instead —
 * everything between there and the position is listed, and the next probe
 * continues below it toward the older end.
 *
 * The point never travels past an unreadable transaction either: the sweep
 * asks for each one it skipped again directly, by signature, so the probe's
 * progress deeper into the region never has to be traded for the reach of the
 * transactions behind it. A list outgrown by its own asks drops the point, so
 * the transactions past the cap are listed and collected once more.
 */
function resumePoint(
  fallbackRan: boolean,
  probeComplete: boolean,
  probeEnded: boolean,
  probeDeepest: { signature: Signature; slot: string } | null,
  gapComplete: boolean,
  gapDeepest: { signature: Signature; slot: string } | null,
  unlistedBehindPosition: boolean,
  overflowedRetries: boolean
): { signature: Signature; slot: string } | null {
  if (!fallbackRan || !probeEnded || overflowedRetries) {
    return null;
  }
  if (unlistedBehindPosition && !gapComplete) {
    return gapDeepest;
  }
  return probeComplete ? null : probeDeepest;
}

/**
 * The two retry lists joined, the fresh row's entries first, a signature
 * counted once. Both sweeps' asks stay owed: whichever write lands, a
 * transaction either sweep could not read is still asked about.
 */
function mergeUnreadableRetries(
  fresh: DvpLegTransferScan["unreadableRetries"],
  mine: DvpLegTransferScan["unreadableRetries"]
): DvpLegTransferScan["unreadableRetries"] {
  const entries = [...fresh];
  const seen = new Set(entries.map((retry) => retry.signature));
  for (const retry of mine) {
    if (!seen.has(retry.signature)) {
      seen.add(retry.signature);
      entries.push(retry);
    }
  }
  return entries.slice(0, UNREADABLE_RETRY_CAP);
}

/**
 * Saves the sweep's scan against the stamp of the scan it read. A write the
 * row has outgrown -- a concurrent sweep saved first -- is refused, and the
 * sweep merges what that one left behind: the fresh row's position and probe
 * stand, and the two retry lists join so neither sweep's unreadable
 * transactions lose their ask. One merge is attempted; a second refusal
 * leaves the row as the concurrent sweep wrote it, and the leg stays due, so
 * the next sweep reads the row fresh and walks again.
 */
async function persistTheScan(
  transfers: DvpLegTransferRepository,
  leg: DvpLegEscrow,
  scan: Omit<DvpLegTransferScan, "version">,
  seen: SeenScan | null
): Promise<void> {
  if (await transfers.saveScan(leg.tradeId, scan, seen?.version)) {
    return;
  }
  const fresh = (await transfers.listScans(leg.tradeId)).find((row) => row.side === leg.side);
  if (fresh !== undefined) {
    await transfers.saveScan(
      leg.tradeId,
      {
        ...fresh,
        unreadableRetries: mergeUnreadableRetries(fresh.unreadableRetries, scan.unreadableRetries),
      },
      fresh.version
    );
  }
}

/**
 * A scan as the sweep read it: the row's own stamp when it came from the row,
 * and no stamp at all when the leg was never read.
 */
type SeenScan = Omit<DvpLegTransferScan, "version"> & { version?: string };

/**
 * Reads a leg's escrow history from where the last read stopped, records every
 * transfer in it, and moves the read position forward.
 *
 * Oldest first, so the position only ever advances over signatures that were
 * resolved and finalized. It stops at the first RPC failure, at a transaction
 * the cluster does not serve yet, or when the sweep's budget runs out, and the
 * next sweep carries on from there. Writes go rows first and position last, so
 * a crash between them costs one re-read of rows the ledger already holds.
 *
 * @param reader - The chain.
 * @param transfers - The ledger.
 * @param leg - The escrow to read.
 * @param scan - Where this leg's last read stopped, or null for a first read.
 * @param budget - Transactions the sweep may still read; decremented here.
 * @param now - The instant this sweep runs at, which stamps the scan and
 *   paces the audit; defaults to the clock. The sweep passes its own so every
 *   leg in it agrees on the time.
 * @param memo - Signatures whose read outcome this process already knows,
 *   so a region full of transactions that move nothing costs a listing and
 *   not a read; defaults to a memo no sweep shares. The reconciler passes
 *   one process-wide, which is what lets the probe walk the same pages
 *   again without spending the sweep's budget on answers it already has.
 * @returns How many transfers were recorded.
 */
export async function syncDvpLegTransfers(
  reader: DvpEscrowHistoryReader,
  transfers: DvpLegTransferRepository,
  leg: DvpLegEscrow,
  scan: SeenScan | null,
  budget: DvpLegTransferBudget,
  now: number = Date.now(),
  memo: DvpLegTransferReadMemo = createDvpLegTransferReadMemo()
): Promise<number> {
  const stored = scan?.cursor ?? null;
  const probe = scan?.probe ?? null;
  const since = historyBound(scan, now);
  // Whether the sweep saw the leg's whole history. A read the cap cut off in
  // the middle leaves this false, so the leg stays due and asks again.
  const { read, bounded, chunked, probeComplete, probeDeepest, gapComplete, gapDeepest } =
    await readTheSweep(reader, leg, since, stored, probe);
  if (read === null) {
    getLogger().warn(
      { tradeId: leg.tradeId, side: leg.side, escrow: leg.escrow },
      "dvp transfers: escrow history since the last read exceeds the scan cap"
    );
    return 0;
  }
  const newestFirst = read.entries;
  // The listing an advance may be proven by: every entry of a single read,
  // but in the fallback only the bounded read's own — the probe of the region
  // below the cursor is a listing of its, and its depth says nothing about
  // what the bounded read listed above the cursor.
  const advancing = bounded ?? newestFirst.length;
  const evidence = newestFirst.slice(0, advancing);
  // The deepest signature the bounded read listed. When the read was cut by
  // the cap, this is where the position must stand: nothing deeper was listed,
  // and a position higher up would fence the region behind it past every
  // probe the cap allows.
  const deepestListed = chunked ? (newestFirst[advancing - 1] ?? null) : null;

  const known = new Map(
    (await transfers.listForLeg(leg.tradeId, leg.side)).map((transfer) => [
      transfer.signature,
      transfer,
    ])
  );
  // The transactions the last sweeps could not read with confidence are the
  // oldest unsettled business this leg has: they are asked for again before
  // the walk spends the budget on anything newer.
  const keptRetries = await retryUnreadableReads(
    reader,
    transfers,
    leg,
    scan?.unreadableRetries,
    known,
    budget,
    memo
  );
  let cursor = stored;
  // The watermark qualifies the cursor it arrived with: a stored cursor was
  // only ever saved over a slot the listing continued below.
  let cursorSlotComplete = scan?.cursorSlotComplete ?? false;
  let finalizedSoFar = true;
  let complete = !chunked;
  // Whether the walk got through the region behind the cursor: it did unless
  // a transaction there the node would not serve stopped it.
  let probeEnded = true;
  let recorded = 0;
  // Whether the walk advanced onto the deepest listed signature: only then
  // may the position stand there.
  let deepestReached = false;
  // The transactions whose balances the walk could not read with confidence.
  // The ones behind the position it saves are owed a read of their own, since
  // the walk never lists behind the position again.
  const unreadableSkips: DvpEscrowHistoryEntry[] = [];
  // The walk resolves the listings oldest first — the probe of the region
  // behind the cursor before the bounded read ahead of it, so the ledger's
  // sequence keeps the transfers in the order the chain lists them.
  const walk = [...newestFirst].reverse().map((entry, position) => ({
    entry,
    mayAdvance: newestFirst.length - 1 - position < advancing,
  }));
  for (const { entry, mayAdvance } of walk) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- oldest first, so the read position only advances over resolved signatures.
    const outcome = await resolveEntry(
      reader,
      transfers,
      leg,
      entry,
      known,
      budget,
      memo,
      unreadableSkips
    );
    if (outcome.step === "stop") {
      complete = false;
      // A stop anywhere in the probe's region leaves what it listed behind it
      // unaccounted for: the finds the walk never got through sit above the
      // deepest page, so neither the position's proof nor a resume point
      // below them may survive — the next sweep probes from the position
      // again, where they are listed and tried once more.
      if (!mayAdvance) {
        probeEnded = false;
      }
      if (endsTheWalk(outcome.reason, mayAdvance)) {
        break;
      }
      continue;
    }
    recorded += outcome.recorded ? 1 : 0;
    if (finalizedSoFar && entry.finalized) {
      const advanced = advancedPosition(
        cursor,
        cursorSlotComplete,
        entry,
        mayAdvance,
        read.floorReached,
        evidence
      );
      ({ cursor, cursorSlotComplete } = advanced);
      if (deepestListed !== null && entry.signature === deepestListed.signature) {
        deepestReached = advanced.cursor?.signature === deepestListed.signature;
      }
    } else {
      finalizedSoFar = false;
    }
  }

  // A chunked read kept everything its bounded listing reached, and the walk
  // resolved it oldest first. When the walk got through the deepest of it,
  // the position stands there: the region the read never listed sits
  // immediately behind the position, within the next sweep's probe, instead
  // of beyond every probe the cap allows.
  if (deepestReached && deepestListed !== null) {
    cursor = { signature: deepestListed.signature, slot: deepestListed.slot.toString() };
  }

  const unaccounted = await removeDroppedTransfers(
    reader,
    transfers,
    leg,
    known,
    new Set(newestFirst.map((entry) => entry.signature))
  );

  // Only a read that got through to the newest signature with nothing left
  // provisional and nothing skipped in the middle counts as a scan. A probe
  // the cap stopped part way through the region behind the position leaves
  // that region partly unlisted, which is not a scan either. Anything less
  // leaves the leg due next sweep.
  const settled = settledRead(complete, finalizedSoFar, unaccounted, chunked, probeComplete);
  const { retries: unreadableRetries, overflowed } = nextUnreadableRetries(
    keptRetries,
    unreadableSkips,
    cursor
  );
  await persistTheScan(
    transfers,
    leg,
    {
      side: leg.side,
      cursor,
      // A probe that did not run to its end leaves the next sweep asking for the
      // whole history: the position may stand, but the region behind it is not
      // yet accounted for, and the probe is the one read that reaches what a
      // walk bounded at the position never lists again. A chunked read never
      // proves the position it read on to either: the region it skipped sits
      // immediately behind the position, where only the next sweep's probe
      // sees it.
      cursorSlotComplete: provenPosition(
        cursor,
        cursorSlotComplete,
        probeEnded,
        chunked,
        probeComplete
      ),
      probe: resumePoint(
        bounded !== null,
        probeComplete,
        probeEnded,
        probeDeepest,
        gapComplete,
        gapDeepest,
        standsBeforeAnUnlistedRegion(chunked, deepestReached),
        overflowed
      ),
      unreadableRetries,
      scannedAt: settled ? new Date(now).toISOString() : null,
    },
    scan
  );
  return recorded;
}
