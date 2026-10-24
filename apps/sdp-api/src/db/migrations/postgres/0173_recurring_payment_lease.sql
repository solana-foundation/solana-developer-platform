-- Fences the run that holds a recurring payment's activation, update, cancel
-- or resume (SOLA9-697, SOLA9-732, SOLA9-716).
--
-- Each of those claims moves the schedule to its processing status, and a
-- later claim takes it over once it has been stale for 15 minutes, resuming
-- the same in-flight attempt. Without a fence, the run that went stale can
-- wake after a takeover and save a signature, broadcast, finalize or fail the
-- schedule the new run now owns.
--
-- Every claim, fresh or a takeover, writes a new `lease_id`, and the run keeps
-- the one it wrote. Each step save (made before its broadcast), finalize and
-- failure reset first locks the row FOR UPDATE where `lease_id` still matches,
-- in the same transaction as its writes; no row means another run took over,
-- so it writes nothing and never broadcasts, as the authority revocation lease
-- (0153) does. The lock orders a takeover's claim after that transaction.
--
-- Nullable with no default, so the previous revision, which never writes it,
-- keeps working. A row nobody has claimed since has none, and the next claim
-- writes one.

ALTER TABLE payment_recurring_payments
    ADD COLUMN IF NOT EXISTS lease_id TEXT;
