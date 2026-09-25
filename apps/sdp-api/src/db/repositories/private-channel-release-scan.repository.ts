/**
 * How far the private-channel withdrawal release reconciler has walked each
 * (instance, mint) escrow ATA's address history (SOLA9-157).
 *
 * Two positions are persisted per (instance, mint, escrow ATA):
 *
 * - `cursor` — the parsed frontier. Everything at or older than it has been
 *   fully parsed and matched against a complete unsettled batch. It advances
 *   only toward newer slots (history is consumed oldest-first) and never
 *   moves back, so an overlapping slower sweep cannot undo a faster one's
 *   progress.
 * - `sweep` — the deepest signature listed by a walk that hit its page cap
 *   before reaching the cursor. A later tick resumes listing below it, so a
 *   backlog deeper than one tick's page cap is still eventually consumed. It
 *   only moves deeper (to an older slot) and is cleared once the cursor has
 *   consumed the listed backlog.
 *
 * The escrow ATA is part of the row key: the instance's escrow can be rotated,
 * and the reconciler only reads the row for the CURRENT escrow ATA. Positions
 * derived from a different ATA are never consulted, and a lagging poller that
 * still holds the pre-rotation address cannot clobber the rotated escrow's
 * progress (or vice versa).
 */

import type { Signature } from "@solana/kit";
import type { RepositoryDbClient } from "./base";

/** One persisted walk position (signature plus its slot, as text — a u64). */
export interface PrivateChannelReleaseScanCursor {
  signature: Signature;
  /** Slot of `signature`, as text (a u64). */
  slot: string;
}

/** The persisted positions for one (instance, mint) escrow ATA. */
export interface PrivateChannelReleaseScan {
  /** The parsed frontier, or null before the first complete walk. */
  cursor: PrivateChannelReleaseScanCursor | null;
  /** The deepest listed signature of a capped walk, or null with no backlog. */
  sweep: PrivateChannelReleaseScanCursor | null;
}

export interface AdvanceReleaseScanInput {
  instanceId: string;
  mint: string;
  /** The escrow ATA the position was derived from; a rotated escrow starts fresh. */
  vaultAta: string;
  cursor: PrivateChannelReleaseScanCursor;
}

export interface DeepenReleaseSweepInput {
  instanceId: string;
  mint: string;
  vaultAta: string;
  sweep: PrivateChannelReleaseScanCursor;
}

export interface ClearReleaseSweepInput {
  instanceId: string;
  mint: string;
  vaultAta: string;
}

export interface PrivateChannelReleaseScanRepository {
  /**
   * The positions previously recorded for this (instance, mint) escrow ATA, or
   * null before the first write. Either position may be null independently:
   * the sweep exists before the first complete walk, the cursor after it.
   */
  getScan(
    instanceId: string,
    mint: string,
    vaultAta: string
  ): Promise<PrivateChannelReleaseScan | null>;
  /**
   * Records where parsing stopped. The cursor only moves toward newer slots
   * (the frontier advances as history is consumed); an older-slot proposal —
   * e.g. from an overlapping slower sweep that parsed less — never undoes the
   * stored position.
   */
  advanceScan(input: AdvanceReleaseScanInput): Promise<void>;
  /**
   * Records where listing stopped (a walk that hit its page cap before the
   * cursor). The sweep only moves deeper (to an older slot); a shallower
   * proposal never regresses it.
   */
  deepenSweep(input: DeepenReleaseSweepInput): Promise<void>;
  /** Clears the sweep once the cursor has consumed the listed backlog. */
  clearSweep(input: ClearReleaseSweepInput): Promise<void>;
}

export interface PrivateChannelReleaseScanRepositoryContext {
  db: RepositoryDbClient;
}

interface ReleaseScanRow {
  cursor_signature: unknown;
  cursor_slot: unknown;
  sweep_signature: unknown;
  sweep_slot: unknown;
}

function position(
  signature: unknown,
  slot: unknown,
  label: string
): PrivateChannelReleaseScanCursor | null {
  if (signature === null && slot === null) {
    return null;
  }
  if (typeof signature !== "string" || typeof slot !== "string") {
    // The columns are NULL together; a driver that hands back anything else is
    // never read as a position.
    throw new Error(`private_channel_release_scans row carries an invalid ${label}`);
  }
  return { signature: signature as Signature, slot };
}

export function createPostgresPrivateChannelReleaseScanRepository(
  db: RepositoryDbClient
): PrivateChannelReleaseScanRepository {
  return {
    async getScan(instanceId, mint, vaultAta) {
      const row = await db
        .prepare(
          `SELECT cursor_signature, cursor_slot, sweep_signature, sweep_slot
             FROM private_channel_release_scans
            WHERE instance_id = ? AND mint = ? AND vault_ata = ?`
        )
        .bind(instanceId, mint, vaultAta)
        .first<ReleaseScanRow>();
      if (!row) {
        return null;
      }
      return {
        cursor: position(row.cursor_signature, row.cursor_slot, "cursor"),
        sweep: position(row.sweep_signature, row.sweep_slot, "sweep"),
      };
    },
    async advanceScan(input) {
      await db
        .prepare(
          `INSERT INTO private_channel_release_scans
             (instance_id, mint, vault_ata, cursor_signature, cursor_slot)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (instance_id, mint, vault_ata) DO UPDATE SET
             cursor_signature = EXCLUDED.cursor_signature,
             cursor_slot = EXCLUDED.cursor_slot,
             updated_at = sdp_iso_now()
           WHERE private_channel_release_scans.cursor_slot IS NULL
              OR EXCLUDED.cursor_slot::numeric > private_channel_release_scans.cursor_slot::numeric`
        )
        .bind(
          input.instanceId,
          input.mint,
          input.vaultAta,
          input.cursor.signature,
          input.cursor.slot
        )
        .run();
    },
    async deepenSweep(input) {
      await db
        .prepare(
          `INSERT INTO private_channel_release_scans
             (instance_id, mint, vault_ata, sweep_signature, sweep_slot)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (instance_id, mint, vault_ata) DO UPDATE SET
             sweep_signature = EXCLUDED.sweep_signature,
             sweep_slot = EXCLUDED.sweep_slot,
             updated_at = sdp_iso_now()
           WHERE private_channel_release_scans.sweep_signature IS NULL
              OR EXCLUDED.sweep_slot::numeric < private_channel_release_scans.sweep_slot::numeric`
        )
        .bind(input.instanceId, input.mint, input.vaultAta, input.sweep.signature, input.sweep.slot)
        .run();
    },
    async clearSweep(input) {
      await db
        .prepare(
          `UPDATE private_channel_release_scans
              SET sweep_signature = NULL, sweep_slot = NULL, updated_at = sdp_iso_now()
            WHERE instance_id = ? AND mint = ? AND vault_ata = ?`
        )
        .bind(input.instanceId, input.mint, input.vaultAta)
        .run();
    },
  };
}
