-- A version stamp for the transfer scan row, so a sweep that read it a moment
-- ago does not overwrite what a concurrent sweep just wrote (APE-881).
--
-- Two sweeps can overlap on the same leg. The row's cursor was already guarded
-- against moving backwards, and the probe point against losing depth, but the
-- retry list -- the transactions behind the position a sweep could not read
-- with confidence -- is the sweep's own word for what is still owed a read: a
-- slower sweep saving its own list would erase the transactions the faster
-- sweep had just queued, and nothing would ever ask for them again.
--
-- The stamp rises with every write. A sweep saves against the stamp it read,
-- and a save that arrives after the row moved is refused, so the sweep can
-- merge what the concurrent sweep left behind and try once more.
--
-- Written only by the reconciler, a system workload, under the policies 0111
-- already put on this table.

ALTER TABLE dvp_leg_transfer_scans
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 0;
