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
   * False while the transaction is confirmed but not finalized. A provisional
   * row is deleted if the cluster drops its transaction.
   */
  finalized: boolean;
}

/** Where a leg's history read stopped, and when it last ran. */
export interface DvpLegTransferScan {
  side: "a" | "b";
  /**
   * The newest finalized signature every older one was resolved behind, with
   * its slot; null before any.
   */
  cursor: { signature: Signature; slot: string } | null;
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
});

const scanRowSchema = z.object({
  side: z.enum(["a", "b"]),
  cursor_signature: z.string().nullable(),
  cursor_slot: z.string().regex(/^\d+$/).nullable(),
  scanned_at: z.string().nullable(),
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
  };
}

function toScan(row: Record<string, unknown>): DvpLegTransferScan {
  const parsed = scanRowSchema.parse(row);
  if ((parsed.cursor_signature === null) !== (parsed.cursor_slot === null)) {
    // The table's CHECK makes this unreachable; a half cursor is never read as none.
    throw new Error("dvp_leg_transfer_scans row carries half a cursor");
  }
  return {
    side: parsed.side,
    cursor:
      parsed.cursor_signature === null || parsed.cursor_slot === null
        ? null
        : { signature: signature(parsed.cursor_signature), slot: parsed.cursor_slot },
    scannedAt: parsed.scanned_at,
  };
}

const TRANSFER_COLUMNS =
  "trade_id, side, signature, direction, amount, slot, block_time, fee_payer, finalized";

export interface DvpLegTransferRepository {
  /**
   * Records one transfer. A row already recorded for this (trade, side,
   * signature) keeps its reading, which came off the same transaction, and
   * only ever moves from provisional to finalized.
   */
  record(transfer: DvpLegTransfer): Promise<void>;
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
   * undo a faster one's progress.
   */
  saveScan(tradeId: string, scan: DvpLegTransferScan): Promise<void>;
}

export function createPostgresDvpLegTransferRepository(
  db: RepositoryDbClient
): DvpLegTransferRepository {
  return {
    async record(transfer) {
      await db
        .prepare(
          `INSERT INTO dvp_leg_transfers (${TRANSFER_COLUMNS})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          transfer.finalized
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
            ORDER BY slot::numeric ASC, signature ASC`
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
            ORDER BY slot::numeric ASC, signature ASC`
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
          `SELECT side, cursor_signature, cursor_slot, scanned_at
             FROM dvp_leg_transfer_scans
            WHERE trade_id = ?`
        )
        .bind(tradeId)
        .all<Record<string, unknown>>();
      return result.results.map(toScan);
    },

    async saveScan(tradeId, scan) {
      const cursorSignature = scan.cursor === null ? null : scan.cursor.signature;
      const cursorSlot = scan.cursor === null ? null : scan.cursor.slot;
      // Both CASEs read the stored row as it was before this statement, so the
      // signature and its slot always move together.
      await db
        .prepare(
          `INSERT INTO dvp_leg_transfer_scans (trade_id, side, cursor_signature, cursor_slot, scanned_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (trade_id, side)
           DO UPDATE SET
             cursor_signature = CASE
               WHEN EXCLUDED.cursor_slot IS NOT NULL
                AND (dvp_leg_transfer_scans.cursor_slot IS NULL
                     OR EXCLUDED.cursor_slot::numeric >= dvp_leg_transfer_scans.cursor_slot::numeric)
               THEN EXCLUDED.cursor_signature
               ELSE dvp_leg_transfer_scans.cursor_signature END,
             cursor_slot = CASE
               WHEN EXCLUDED.cursor_slot IS NOT NULL
                AND (dvp_leg_transfer_scans.cursor_slot IS NULL
                     OR EXCLUDED.cursor_slot::numeric >= dvp_leg_transfer_scans.cursor_slot::numeric)
               THEN EXCLUDED.cursor_slot
               ELSE dvp_leg_transfer_scans.cursor_slot END,
             scanned_at = EXCLUDED.scanned_at`
        )
        .bind(tradeId, scan.side, cursorSignature, cursorSlot, scan.scannedAt)
        .run();
    },
  };
}
