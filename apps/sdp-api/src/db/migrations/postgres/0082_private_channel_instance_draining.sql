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

-- Identity of ONE drain episode, so a deletion can prove the drain it is acting
-- on is still the drain it started. A timestamp cannot carry that proof: resume
-- and re-drain inside the same millisecond would read as the same drain, and a
-- deletion that had already been abandoned would delete the resumed instance.
-- The CHECK keeps the two columns from ever drifting apart — a draining
-- instance always has a token, and a resumed one never does.
ALTER TABLE private_channel_instances
    ADD COLUMN IF NOT EXISTS draining_token TEXT;

ALTER TABLE private_channel_instances
    DROP CONSTRAINT IF EXISTS private_channel_instances_draining_pair;
ALTER TABLE private_channel_instances
    ADD CONSTRAINT private_channel_instances_draining_pair
    CHECK ((draining_at IS NULL) = (draining_token IS NULL));

-- Guard query: are there non-terminal transfers blocking instance deletion?
-- The deposit and withdrawal tables already carry this index (migration 0040);
-- transfers did not, because nothing counted them by instance until the
-- deletion gate did. It runs while holding the instance row lock, so an
-- unindexed scan of transfer history would delay both deletion and every
-- movement waiting on that lock.
CREATE INDEX IF NOT EXISTS idx_private_channel_transfers_instance_status
    ON private_channel_transfers(instance_id)
    WHERE status IN ('pending', 'submitted');
