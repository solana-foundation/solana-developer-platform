/**
 * The token movements in and out of each leg's escrow, read off the chain by
 * the reconciler (PRO-1941), and how far each leg's history has been read.
 *
 * Written only under a system identity (0111). Read by whoever can read the
 * trade: its organization, or a party named on it.
 */

import { type Address, address, type Signature, signature } from "@solana/kit";
import { z } from "zod";
import type { RepositoryDbClient } from "./base";

export type DvpLegTransferDirection = "in" | "out";

export interface DvpLegTransfer {
  tradeId: string;
  side: "a" | "b";
  signature: Signature;
  direction: DvpLegTransferDirection;
  /** Base units moved, always positive. */
  amount: string;
  slot: string;
  /** Unix seconds, or null when the cluster recorded no time for the block. */
  blockTime: string | null;
  feePayer: Address;
  /**
   * Where this transfer sits in the escrow's history, counted per leg. Assigned
   * as the reconciler walks that history oldest first, so transfers in one slot
   * keep the order the cluster listed them in.
   */
  sequence: string;
  /**
   * False while the transaction is confirmed but not finalized. A provisional
   * row is deleted if the cluster drops its transaction.
   */
  finalized: boolean;
}

/**
 * A transfer as the reader hands it over. Its place in the leg's history is the
 * ledger's to assign, from the order the walk reaches it in.
 */
export type NewDvpLegTransfer = Omit<DvpLegTransfer, "sequence">;

/** Where a leg's history read stopped, and when it last ran. */
export interface DvpLegTransferScan {
  side: "a" | "b";
  /**
   * The newest finalized signature every older one was resolved behind, with
   * its slot; null before any. Within the cursor's own slot that resolution
   * extends to every older signature only when `cursorSlotComplete` says the
   * listing continued below the slot.
   */
  cursor: { signature: Signature; slot: string } | null;
  /**
   * Whether the read that set the cursor saw the listing continue below the
   * cursor's slot — an entry at an earlier slot, or history past the trade's
   * creation. A page that stops inside the slot proves nothing: a node caught
   * mid-index can list the newest of two same-slot movements and omit the
   * older, and a later read bounded at the cursor would never be offered it
   * again. False reads the whole overlap from the top next time, where the
   * omission can still surface.
   */
  cursorSlotComplete: boolean;
  /**
   * Where the next sweep's probe of the region behind the cursor resumes, with
   * its slot; null to probe from the cursor itself. The fallback's probe reads
   * the region only it reaches — where a node's omission sits — a few pages at
   * a time, and this is how far the last one got. A probe that ran to its end
   * drops the point, so the next one starts behind the position again.
   */
  probe: { signature: Signature; slot: string } | null;
  /**
   * The transactions behind the read position whose balances a sweep could not
   * read with confidence, oldest first. The probe that reaches that region
   * carries its resume point, so it lists each part of it once and never comes
   * back; these are asked for again directly, by signature, until the cluster
   * serves one in a shape the ledger can read.
   */
  unreadableRetries: {
    signature: Signature;
    slot: string;
    /** The finality the listing carried when the read was skipped. */
    finalized: boolean;
  }[];
  /**
   * Rises with every write of this row. A sweep saves against the stamp it
   * read, so a write that arrives after a concurrent sweep's own is refused
   * and the sweep can merge what that one left behind.
   */
  version: string;
  /**
   * When a read last got through to the newest signature with nothing left
   * provisional; null when none has, which makes the leg due.
   */
  scannedAt: string | null;
}

/** Each leg's transfers, oldest first. */
export interface DvpTradeLegTransfers {
  a: DvpLegTransfer[];
  b: DvpLegTransfer[];
}

const transferRowSchema = z.object({
  trade_id: z.string(),
  side: z.enum(["a", "b"]),
  signature: z.string(),
  direction: z.enum(["in", "out"]),
  amount: z.string().regex(/^[1-9]\d*$/),
  slot: z.string().regex(/^\d+$/),
  block_time: z.string().regex(/^\d+$/).nullable(),
  fee_payer: z.string(),
  finalized: z.boolean(),
  // BIGINT. The driver hands it back as a number, a bigint or text depending on
  // the column's width and its own settings, so all three are read as the
  // integer they are and carried as text like every other u64-shaped value.
  sequence: z.union([
    z.string().regex(/^\d+$/),
    z.bigint().transform(String),
    z.number().int().nonnegative().transform(String),
  ]),
});

const unreadableRetrySchema = z.object({
  signature: z.string(),
  slot: z.string().regex(/^\d+$/),
  finalized: z.boolean(),
});

const scanRowSchema = z.object({
  side: z.enum(["a", "b"]),
  cursor_signature: z.string().nullable(),
  cursor_slot: z.string().regex(/^\d+$/).nullable(),
  cursor_slot_complete: z.boolean(),
  probe_signature: z.string().nullable(),
  probe_slot: z.string().regex(/^\d+$/).nullable(),
  unreadable_retries: z.array(unreadableRetrySchema),
  scanned_at: z.string().nullable(),
  // BIGINT. The driver hands it back as a number, a bigint or text depending on
  // the column's width and its own settings, so all three are read as the
  // integer they are and carried as text like every other u64-shaped value.
  version: z.union([
    z.string().regex(/^\d+$/),
    z.bigint().transform(String),
    z.number().int().nonnegative().transform(String),
  ]),
});

function toTransfer(row: Record<string, unknown>): DvpLegTransfer {
  const parsed = transferRowSchema.parse(row);
  return {
    tradeId: parsed.trade_id,
    side: parsed.side,
    signature: signature(parsed.signature),
    direction: parsed.direction,
    amount: parsed.amount,
    slot: parsed.slot,
    blockTime: parsed.block_time,
    feePayer: address(parsed.fee_payer),
    finalized: parsed.finalized,
    sequence: parsed.sequence,
  };
}

function toScan(row: Record<string, unknown>): DvpLegTransferScan {
  const parsed = scanRowSchema.parse(row);
  if ((parsed.cursor_signature === null) !== (parsed.cursor_slot === null)) {
    // The table's CHECK makes this unreachable; a half cursor is never read as none.
    throw new Error("dvp_leg_transfer_scans row carries half a cursor");
  }
  if ((parsed.probe_signature === null) !== (parsed.probe_slot === null)) {
    // The table's CHECK makes this unreachable; a half probe point is never
    // read as none.
    throw new Error("dvp_leg_transfer_scans row carries half a probe point");
  }
  return {
    side: parsed.side,
    cursor:
      parsed.cursor_signature === null || parsed.cursor_slot === null
        ? null
        : { signature: signature(parsed.cursor_signature), slot: parsed.cursor_slot },
    cursorSlotComplete: parsed.cursor_slot_complete,
    probe:
      parsed.probe_signature === null || parsed.probe_slot === null
        ? null
        : { signature: signature(parsed.probe_signature), slot: parsed.probe_slot },
    unreadableRetries: parsed.unreadable_retries.map((retry) => ({
      signature: signature(retry.signature),
      slot: retry.slot,
      finalized: retry.finalized,
    })),
    scannedAt: parsed.scanned_at,
    version: parsed.version,
  };
}

const TRANSFER_COLUMNS =
  "trade_id, side, signature, direction, amount, slot, block_time, fee_payer, finalized, sequence";

export interface DvpLegTransferRepository {
  /**
   * Records one transfer. A row already recorded for this (trade, side,
   * signature) keeps its reading, which came off the same transaction, and
   * only ever moves from provisional to finalized.
   */
  record(transfer: NewDvpLegTransfer): Promise<void>;
  /** Marks a recorded transfer finalized. Never the other way. */
  markFinalized(tradeId: string, side: "a" | "b", signature: Signature): Promise<void>;
  /**
   * Deletes a provisional transfer whose transaction the chain no longer knows.
   * Guarded on `finalized = false`, so a finalized row is never removed.
   */
  deleteProvisional(tradeId: string, side: "a" | "b", signature: Signature): Promise<void>;
  /** One leg's transfers, oldest first. */
  listForLeg(tradeId: string, side: "a" | "b"): Promise<DvpLegTransfer[]>;
  /**
   * Each trade's transfers by leg, oldest first, in one query. A trade with
   * none maps to two empty lists; a trade the caller cannot read maps the same,
   * which the caller could not have asked about in the first place.
   */
  listForTrades(tradeIds: readonly string[]): Promise<Map<string, DvpTradeLegTransfers>>;
  /** Both legs' read positions for one trade; a leg never read is absent. */
  listScans(tradeId: string): Promise<DvpLegTransferScan[]>;
  /**
   * Stores where a leg's history read stopped. The cursor never moves back to
   * an earlier slot than the one stored, so an overlapping slower sweep cannot
   * undo a faster one's progress, and the slot's watermark travels with the
   * cursor it qualifies. A sweep that read the row at `seenVersion` saves
   * against that stamp: the write lands only while the row still carries it,
   * and the boolean answers whether it did.
   */
  saveScan(
    tradeId: string,
    scan: Omit<DvpLegTransferScan, "version">,
    seenVersion?: string
  ): Promise<boolean>;
}

export function createPostgresDvpLegTransferRepository(
  db: RepositoryDbClient
): DvpLegTransferRepository {
  return {
    async record(transfer) {
      await db
        .prepare(
          // The order comes from the walk itself: one past this leg's highest so
          // far, which is the position the cluster's own listing gave it. Two
          // sweeps running at once could hand out the same number, so reads
          // break ties by slot and signature rather than leaving it to chance.
          `INSERT INTO dvp_leg_transfers (${TRANSFER_COLUMNS})
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  COALESCE((SELECT MAX(existing.sequence)
                              FROM dvp_leg_transfers existing
                             WHERE existing.trade_id = ? AND existing.side = ?), 0) + 1
           ON CONFLICT (trade_id, side, signature)
           DO UPDATE SET finalized = dvp_leg_transfers.finalized OR EXCLUDED.finalized`
        )
        .bind(
          transfer.tradeId,
          transfer.side,
          transfer.signature,
          transfer.direction,
          transfer.amount,
          transfer.slot,
          transfer.blockTime,
          transfer.feePayer,
          transfer.finalized,
          transfer.tradeId,
          transfer.side
        )
        .run();
    },

    async markFinalized(tradeId, side, transferSignature) {
      await db
        .prepare(
          `UPDATE dvp_leg_transfers SET finalized = true
            WHERE trade_id = ? AND side = ? AND signature = ? AND finalized = false`
        )
        .bind(tradeId, side, transferSignature)
        .run();
    },

    async deleteProvisional(tradeId, side, transferSignature) {
      await db
        .prepare(
          `DELETE FROM dvp_leg_transfers
            WHERE trade_id = ? AND side = ? AND signature = ? AND finalized = false`
        )
        .bind(tradeId, side, transferSignature)
        .run();
    },

    async listForLeg(tradeId, side) {
      const result = await db
        .prepare(
          `SELECT ${TRANSFER_COLUMNS}
             FROM dvp_leg_transfers
            WHERE trade_id = ? AND side = ?
            ORDER BY sequence ASC, slot::numeric ASC, signature ASC`
        )
        .bind(tradeId, side)
        .all<Record<string, unknown>>();
      return result.results.map(toTransfer);
    },

    async listForTrades(tradeIds) {
      const byTrade = new Map<string, DvpTradeLegTransfers>(
        tradeIds.map((id) => [id, { a: [], b: [] }])
      );
      if (tradeIds.length === 0) {
        return byTrade;
      }
      const placeholders = tradeIds.map(() => "?").join(", ");
      const result = await db
        .prepare(
          `SELECT ${TRANSFER_COLUMNS}
             FROM dvp_leg_transfers
            WHERE trade_id IN (${placeholders})
            ORDER BY sequence ASC, slot::numeric ASC, signature ASC`
        )
        .bind(...tradeIds)
        .all<Record<string, unknown>>();
      for (const row of result.results) {
        const transfer = toTransfer(row);
        byTrade.get(transfer.tradeId)?.[transfer.side].push(transfer);
      }
      return byTrade;
    },

    async listScans(tradeId) {
      const result = await db
        .prepare(
          `SELECT side, cursor_signature, cursor_slot, cursor_slot_complete,
                probe_signature, probe_slot, unreadable_retries, scanned_at, version
           FROM dvp_leg_transfer_scans
          WHERE trade_id = ?`
        )
        .bind(tradeId)
        .all<Record<string, unknown>>();
      return result.results.map(toScan);
    },

    async saveScan(tradeId, scan, seenVersion) {
      const cursorSignature = scan.cursor === null ? null : scan.cursor.signature;
      const cursorSlot = scan.cursor === null ? null : scan.cursor.slot;
      // The watermark qualifies the cursor, so a naked one is never stored.
      const cursorSlotComplete = scan.cursor === null ? false : scan.cursorSlotComplete;
      const probeSignature = scan.probe === null ? null : scan.probe.signature;
      const probeSlot = scan.probe === null ? null : scan.probe.slot;
      // All four CASEs read the stored row as it was before this statement,
      // so the signature, its slot and the slot's watermark move together. The
      // probe point is the sweep's own word for where its probe stopped: a
      // slower sweep overwriting a deeper one only costs the next probe a
      // re-listing of pages it already resolved, never a transfer.
      const cursorAdvances = `EXCLUDED.cursor_slot IS NOT NULL
             AND (dvp_leg_transfer_scans.cursor_slot IS NULL
                  OR EXCLUDED.cursor_slot::numeric >= dvp_leg_transfer_scans.cursor_slot::numeric)`;
      // The sweep saves against the stamp it read the row at. A stamp it never
      // saw (`seenVersion` undefined) writes unconditionally; one the row has
      // outgrown is refused, and the caller merges what the concurrent sweep
      // left behind and tries once more.
      const stampUnmoved =
        seenVersion === undefined
          ? "TRUE"
          : `dvp_leg_transfer_scans.version = ${Number(seenVersion)}::numeric`;
      const rowsAffected = await db
        .prepare(
          `INSERT INTO dvp_leg_transfer_scans (trade_id, side, cursor_signature, cursor_slot, cursor_slot_complete, probe_signature, probe_slot, unreadable_retries, scanned_at, version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?, 1)
         ON CONFLICT (trade_id, side)
         DO UPDATE SET
           cursor_signature = CASE
             WHEN ${cursorAdvances}
             THEN EXCLUDED.cursor_signature
             ELSE dvp_leg_transfer_scans.cursor_signature END,
           cursor_slot = CASE
             WHEN ${cursorAdvances}
             THEN EXCLUDED.cursor_slot
             ELSE dvp_leg_transfer_scans.cursor_slot END,
           cursor_slot_complete = CASE
             WHEN ${cursorAdvances}
             THEN EXCLUDED.cursor_slot_complete
             ELSE dvp_leg_transfer_scans.cursor_slot_complete END,
           probe_signature = EXCLUDED.probe_signature,
           probe_slot = EXCLUDED.probe_slot,
           unreadable_retries = EXCLUDED.unreadable_retries,
           scanned_at = EXCLUDED.scanned_at,
           version = dvp_leg_transfer_scans.version + 1
         WHERE ${stampUnmoved}`
        )
        .bind(
          tradeId,
          scan.side,
          cursorSignature,
          cursorSlot,
          cursorSlotComplete,
          probeSignature,
          probeSlot,
          scan.unreadableRetries.length === 0
            ? "[]"
            : JSON.stringify(
                scan.unreadableRetries.map((retry) => ({
                  signature: retry.signature,
                  slot: retry.slot,
                  finalized: retry.finalized,
                }))
              ),
          scan.scannedAt
        )
        .run();
      return rowsAffected > 0;
    },
  };
}
