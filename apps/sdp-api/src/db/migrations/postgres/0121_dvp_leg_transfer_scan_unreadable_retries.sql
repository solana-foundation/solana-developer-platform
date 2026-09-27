-- A retry list for the transactions a sweep could not read with confidence
-- (APE-881).
--
-- A transaction whose escrow balances cannot be read with confidence is logged
-- and skipped, never recorded as zero, and deliberately not remembered as
-- settled: a caught-up node may yet serve it in a shape the ledger can read,
-- and a transfer sitting in it must stay reachable. While the escrow's whole
-- history fits under the scan cap, every sweep re-lists the transaction and
-- asks for its balances again. Once the fallback reads on from a saved cursor,
-- the probe is what reaches the region behind the position, and it carries its
-- own resume point: a probe that keeps making progress deeper into that region
-- never lists its shallower part again, so a transaction skipped there would
-- stay skipped for good.
--
-- The row therefore remembers the transactions the walk skipped unreadable
-- behind the position, oldest first, and each sweep asks for each one again
-- directly, by signature -- one read, no listing. A read that comes back in a
-- shape the ledger can read records the transfer (or settles that the
-- transaction moved none of the escrow's tokens), and the entry leaves the
-- list; anything else keeps it there for the next sweep. The list is capped,
-- so an escrow whose history is full of unreadable responses is bounded by the
-- same budget every other trade shares.
--
-- Written only by the reconciler, a system workload, under the policies 0111
-- already put on this table.

ALTER TABLE dvp_leg_transfer_scans
  ADD COLUMN IF NOT EXISTS unreadable_retries JSONB NOT NULL DEFAULT '[]';
