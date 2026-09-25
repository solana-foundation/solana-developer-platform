/**
 * How far the private-channel withdrawal release reconciler has walked each
 * (instance, mint) escrow ATA's address history (SOLA9-157).
 *
 * Written only by the reconciler, a system workload (0119). The cursor is what
 * makes release discovery resilient to escrow-ATA history spam: it advances
 * only over fully parsed signatures, only ever moves deeper (to an older
 * slot), and is discarded when the instance's escrow address rotates.
 */

import type { Signature } from "@solana/kit";
import type { RepositoryDbClient } from "./base";

/** A release-scan read position for one (instance, mint) escrow ATA. */
export interface PrivateChannelReleaseScanCursor {
  signature: Signature;
  /** Slot of `signature`, as text (a u64). */
  slot: string;
}

export interface AdvanceReleaseScanInput {
  instanceId: string;
  mint: string;
  /** The escrow ATA the cursor was derived from; a rotated escrow starts fresh. */
  vaultAta: string;
  cursor: PrivateChannelReleaseScanCursor;
}

export interface PrivateChannelReleaseScanRepository {
  /**
   * The scan position previously recorded for this (instance, mint) escrow
   * ATA, or null before the first advance or after an escrow rotation.
   */
  getScan(
    instanceId: string,
    mint: string,
    vaultAta: string
  ): Promise<PrivateChannelReleaseScanCursor | null>;
  /**
   * Records where a scan stopped. The cursor never moves back to a newer slot
   * than the one stored, so an overlapping slower sweep cannot undo a faster
   * one's progress — unless the escrow ATA changed, which discards the old
   * position wholesale.
   */
  advanceScan(input: AdvanceReleaseScanInput): Promise<void>;
}

export interface PrivateChannelReleaseScanRepositoryContext {
  db: RepositoryDbClient;
}

export function createPostgresPrivateChannelReleaseScanRepository(
  db: RepositoryDbClient
): PrivateChannelReleaseScanRepository {
  return {
    async getScan(instanceId, mint, vaultAta) {
      const row = await db
        .prepare(
          `SELECT cursor_signature, cursor_slot
             FROM private_channel_release_scans
            WHERE instance_id = ? AND mint = ? AND vault_ata = ?`
        )
        .bind(instanceId, mint, vaultAta)
        .first<Record<string, unknown>>();
      if (!row) {
        return null;
      }
      if (typeof row.cursor_signature !== "string" || typeof row.cursor_slot !== "string") {
        // The columns are NOT NULL; a driver that hands back anything else is
        // never read as a position.
        throw new Error("private_channel_release_scans row carries an invalid cursor");
      }
      return { signature: row.cursor_signature as Signature, slot: row.cursor_slot };
    },
    async advanceScan(input) {
      await db
        .prepare(
          `INSERT INTO private_channel_release_scans
             (instance_id, mint, vault_ata, cursor_signature, cursor_slot)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (instance_id, mint) DO UPDATE SET
             vault_ata = EXCLUDED.vault_ata,
             cursor_signature = EXCLUDED.cursor_signature,
             cursor_slot = EXCLUDED.cursor_slot,
             updated_at = sdp_iso_now()
           WHERE private_channel_release_scans.vault_ata IS DISTINCT FROM EXCLUDED.vault_ata
              OR EXCLUDED.cursor_slot::numeric < private_channel_release_scans.cursor_slot::numeric`
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
  };
}
