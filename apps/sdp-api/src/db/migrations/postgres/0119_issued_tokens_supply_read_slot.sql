-- Settled-burn bookkeeping must order a burn's settlement against the supply
-- reading that may have absorbed it. The wall-clock stamp
-- (`total_supply_updated_at`) cannot say whether a burn settled before or
-- after the reading it sits on, so the comparison guessed one-sided. The slot
-- each side observed orders them exactly: a reading taken at slot S includes
-- every effect with a slot at or below S.

ALTER TABLE issued_tokens
    ADD COLUMN IF NOT EXISTS total_supply_read_slot INTEGER;

-- Existing rows have no slot for the readings their cache came from. The
-- settled-burn bookkeeping falls back to the stamp comparison until the next
-- refresh records one, so no backfill is possible or needed.
