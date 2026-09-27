-- A resume point for the fallback's probe of the region behind the cursor
-- (APE-881).
--
-- When the escrow's history from the top exceeds the scan cap, the sweep reads
-- on from the saved cursor and probes the region below it, because that is
-- where a node's omission sits and a walk bounded at the cursor alone would
-- never list it again. The probe reads until the trade's creation, so on an
-- escrow that keeps receiving ordinary transfers the region behind the
-- position can run thousands of signatures deep: listing all of it in one
-- sweep is arbitrarily many sequential RPC requests and an arbitrarily large
-- listing held in memory, and it delays every other trade in the batch.
--
-- The probe therefore reads at most the scan cap's pages per sweep, and the
-- row remembers where it stopped, so the next sweep's probe resumes below that
-- instead of starting over behind the position. The region's oldest end stays
-- reachable — it is reached a few pages further down with every sweep — and
-- once a probe runs to its end (a short page or history past the trade's
-- creation) the resume point is dropped and the next one starts behind the
-- position again. An interrupted walk through the probe's finds drops the
-- resume point too, so nothing listed is ever skipped over.
--
-- Written only by the reconciler, a system workload, under the policies 0111
-- already put on this table.

ALTER TABLE dvp_leg_transfer_scans
  ADD COLUMN IF NOT EXISTS probe_signature TEXT;
ALTER TABLE dvp_leg_transfer_scans
  ADD COLUMN IF NOT EXISTS probe_slot TEXT;

-- The resume point is a signature and the slot it was listed at, always both.
ALTER TABLE dvp_leg_transfer_scans
  DROP CONSTRAINT IF EXISTS dvp_leg_transfer_scans_probe_pair_check;
ALTER TABLE dvp_leg_transfer_scans
  ADD CONSTRAINT dvp_leg_transfer_scans_probe_pair_check
  CHECK ((probe_signature IS NULL) = (probe_slot IS NULL));
