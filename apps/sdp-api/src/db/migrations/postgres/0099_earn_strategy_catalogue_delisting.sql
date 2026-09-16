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

-- Catalogue sync always changes status and catalogue_delisted_at together.
-- A status update that leaves the marker untouched is therefore operator-owned,
-- including deprecated -> deprecated. Clear the marker so a later provider
-- relist cannot overwrite that stop.
CREATE OR REPLACE FUNCTION sdp_preserve_earn_strategy_operator_status()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
    IF NEW.catalogue_delisted_at IS NOT DISTINCT FROM OLD.catalogue_delisted_at THEN
        NEW.catalogue_delisted_at := NULL;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS earn_strategy_operator_status_is_sticky ON earn_strategies;
CREATE TRIGGER earn_strategy_operator_status_is_sticky
    BEFORE UPDATE OF status ON earn_strategies
    FOR EACH ROW
    WHEN (OLD.catalogue_delisted_at IS NOT NULL)
    EXECUTE FUNCTION sdp_preserve_earn_strategy_operator_status();
