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
 * last read is somebody spamming it, and is logged rather than chased.
 */
const HISTORY_PAGE_CAP = 3;
/** `getSignatureStatuses` answers at most this many signatures per call. */
const SIGNATURE_STATUS_LIMIT = 256;

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
 * trade's creation. Null when it runs past the page cap, since resolving the
 * oldest of a truncated read would leave a gap behind it no later read fills.
 */
async function readHistorySince(
  reader: DvpEscrowHistoryReader,
  leg: DvpLegEscrow,
  until: Signature | null
): Promise<DvpEscrowHistoryEntry[] | null> {
  const floor = historyFloor(leg);
  const newestFirst: DvpEscrowHistoryEntry[] = [];
  let before: Signature | null = null;
  for (let page = 0; page < HISTORY_PAGE_CAP; page += 1) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- each page starts where the previous one ended.
    const entries = await reader.listSignatures(leg.escrow, { before, until });
    for (const entry of entries) {
      // Newest first, so everything after this one is older still.
      if (entry.blockTime !== null && entry.blockTime < floor) {
        return newestFirst;
      }
      newestFirst.push(entry);
    }
    const oldest = entries.at(-1);
    if (entries.length < HISTORY_PAGE_LIMIT || oldest === undefined) {
      return newestFirst;
    }
    before = oldest.signature;
  }
  return null;
}

type EntryStep = "resolved" | "stop";

/** Resolves one listed signature: recorded, moving nothing, or unreadable and logged. */
async function resolveEntry(
  reader: DvpEscrowHistoryReader,
  transfers: DvpLegTransferRepository,
  leg: DvpLegEscrow,
  entry: DvpEscrowHistoryEntry,
  known: ReadonlyMap<Signature, DvpLegTransfer>,
  budget: DvpLegTransferBudget
): Promise<{ step: EntryStep; recorded: boolean }> {
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
  if (budget.remaining <= 0) {
    return { step: "stop", recorded: false };
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
    return { step: "stop", recorded: false };
  }
  if (read.kind === "not_served") {
    return { step: "stop", recorded: false };
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
    return { step: "resolved", recorded: false };
  }
  if (reading.kind === "none") {
    return { step: "resolved", recorded: false };
  }
  await transfers.record(reading.transfer);
  return { step: "resolved", recorded: true };
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
 * @returns How many transfers were recorded.
 */
export async function syncDvpLegTransfers(
  reader: DvpEscrowHistoryReader,
  transfers: DvpLegTransferRepository,
  leg: DvpLegEscrow,
  scan: DvpLegTransferScan | null,
  budget: DvpLegTransferBudget
): Promise<number> {
  const newestFirst = await readHistorySince(reader, leg, scan?.cursor?.signature ?? null);
  if (newestFirst === null) {
    getLogger().warn(
      { tradeId: leg.tradeId, side: leg.side, escrow: leg.escrow },
      "dvp transfers: escrow history since the last read exceeds the scan cap"
    );
    return 0;
  }

  const known = new Map(
    (await transfers.listForLeg(leg.tradeId, leg.side)).map((transfer) => [
      transfer.signature,
      transfer,
    ])
  );
  let cursor = scan?.cursor ?? null;
  let finalizedSoFar = true;
  let complete = true;
  let recorded = 0;
  for (const entry of [...newestFirst].reverse()) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- oldest first, so the read position only advances over resolved signatures.
    const outcome = await resolveEntry(reader, transfers, leg, entry, known, budget);
    if (outcome.step === "stop") {
      complete = false;
      break;
    }
    recorded += outcome.recorded ? 1 : 0;
    if (finalizedSoFar && entry.finalized) {
      cursor = { signature: entry.signature, slot: entry.slot.toString() };
    } else {
      finalizedSoFar = false;
    }
  }

  const unaccounted = await removeDroppedTransfers(
    reader,
    transfers,
    leg,
    known,
    new Set(newestFirst.map((entry) => entry.signature))
  );

  // Only a read that got through to the newest signature with nothing left
  // provisional counts as a scan. Anything less leaves the leg due next sweep.
  const settled = complete && finalizedSoFar && unaccounted === 0;
  await transfers.saveScan(leg.tradeId, {
    side: leg.side,
    cursor,
    scannedAt: settled ? new Date().toISOString() : null,
  });
  return recorded;
}
