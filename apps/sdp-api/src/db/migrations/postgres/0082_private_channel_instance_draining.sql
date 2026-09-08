-- Durable draining state for private-channel instances (HOO-1011).
--
-- Instance deletion used to be check-then-act: count in-flight deposits and
-- withdrawals, then delete. A value movement admitted between the count and
-- the delete was stranded with no instance to reconcile against. The fix is a
-- persisted drain marker the admission INSERTs check ATOMICALLY (an
-- INSERT ... SELECT guarded on the instance row), so the ordering is:
-- set draining_at → every later admission is refused by the same statement
-- that would create it → the in-flight count is now monotonically
-- non-increasing → delete once it reaches zero.
--
-- Nullable and unindexed on purpose: a NULL means the instance admits
-- movements, and lookups always go through the instance's primary key.
ALTER TABLE private_channel_instances
    ADD COLUMN IF NOT EXISTS draining_at TEXT;

-- Guard query: are there non-terminal transfers blocking instance deletion?
-- The deposit and withdrawal tables already carry this index (migration 0040);
-- transfers did not, because nothing counted them by instance until the
-- deletion gate did. It runs while holding the instance row lock, so an
-- unindexed scan of transfer history would delay both deletion and every
-- movement waiting on that lock.
CREATE INDEX IF NOT EXISTS idx_private_channel_transfers_instance_status
    ON private_channel_transfers(instance_id)
    WHERE status IN ('pending', 'submitted');
