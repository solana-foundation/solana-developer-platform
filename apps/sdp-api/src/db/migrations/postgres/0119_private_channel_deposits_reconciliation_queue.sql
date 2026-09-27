-- The deposit reconciliation queue (`listNonTerminal`) selects the states the
-- cron worker can advance: `pending` and `submitted`. `confirmed` is terminal
-- for private-channel deposits (`confirmed -> settled` is not driven; the
-- operator's channel-side credit is off-chain and not observable), so a page
-- of confirmed rows was finished work the worker could never do — 100 of them
-- permanently starved every newer pending or submitted deposit behind the
-- LIMIT (Apex SOLA9-544).
--
-- The repository predicates now exclude `confirmed`; these partial indexes
-- must agree with them, or the narrowed queue reads fall off the index.
-- Recreated with the same key as 0040, only the state predicate changes.

DROP INDEX IF EXISTS idx_private_channel_deposits_pending;

CREATE INDEX IF NOT EXISTS idx_private_channel_deposits_pending
    ON private_channel_deposits(updated_at)
    WHERE status IN ('pending', 'submitted');

DROP INDEX IF EXISTS idx_private_channel_deposits_instance_status;

CREATE INDEX IF NOT EXISTS idx_private_channel_deposits_instance_status
    ON private_channel_deposits(instance_id)
    WHERE status IN ('pending', 'submitted');
