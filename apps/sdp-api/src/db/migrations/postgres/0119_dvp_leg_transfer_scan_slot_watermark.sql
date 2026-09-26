-- A same-slot watermark for the transfer scan cursor (APE-881, SOLA9-676).
--
-- Two movements can share a slot, and a node caught mid-index can list the
-- newer one while omitting the older. The cursor then sat on a signature whose
-- older same-slot neighbours were never resolved, and every later read bounded
-- at the cursor would be refused them for good: the leg's ledger stays
-- incomplete, with no contributor or fee-payer attribution to recover.
--
-- The watermark records whether the read that set the cursor saw the listing
-- continue below the cursor's slot — an entry at an earlier slot, or history
-- past the trade's creation. A page that stops inside the slot proves nothing,
-- so a false watermark reads the whole overlap from the top next sweep, where
-- the omission can still surface, and the cursor is trusted as a bound only
-- once the slot is proven. Existing cursors were saved without the proof, so
-- they re-read the overlap once and settle the watermark from what the listing
-- then shows.
--
-- Written only by the reconciler, a system workload, under the policies 0111
-- already put on this table.

ALTER TABLE dvp_leg_transfer_scans
  ADD COLUMN IF NOT EXISTS cursor_slot_complete BOOLEAN NOT NULL DEFAULT false;

-- The watermark qualifies the cursor: a naked one is never stored.
ALTER TABLE dvp_leg_transfer_scans
  DROP CONSTRAINT IF EXISTS dvp_leg_transfer_scans_cursor_slot_complete_check;
ALTER TABLE dvp_leg_transfer_scans
  ADD CONSTRAINT dvp_leg_transfer_scans_cursor_slot_complete_check
  CHECK (cursor_signature IS NOT NULL OR NOT cursor_slot_complete);
