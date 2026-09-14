-- Preserve the immutable vault and mint metadata required to exit an
-- anonymous Earn position after its provider removes the strategy from the
-- live catalogue. The sync marks such rows deprecated instead of deleting
-- them. This timestamp distinguishes a sync-owned tombstone from an operator
-- pause/deprecation so a later provider relist can safely reactivate only the
-- former.

ALTER TABLE earn_strategies
    ADD COLUMN IF NOT EXISTS catalogue_delisted_at TEXT;

COMMENT ON COLUMN earn_strategies.catalogue_delisted_at IS
    'Set when catalogue sync deprecates an unlisted strategy; null for operator-owned status changes.';
