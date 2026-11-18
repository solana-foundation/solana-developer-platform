-- Persist the exact unsigned prerequisite without duplicating the signed outbox.
-- Operation attempts retain signed bytes; the advisory binds their immutable plan
-- and observed chain outcome. Existing advisory writers remain compatible.
ALTER TABLE earn_split_swap_advisories
  ADD COLUMN IF NOT EXISTS custody_wallet_id TEXT,
  ADD COLUMN IF NOT EXISTS unsigned_transaction TEXT,
  ADD COLUMN IF NOT EXISTS swap_signature TEXT,
  ADD COLUMN IF NOT EXISTS swap_chain_status TEXT,
  ADD COLUMN IF NOT EXISTS swap_observed_slot NUMERIC,
  ADD COLUMN IF NOT EXISTS swap_failure_reason TEXT;

ALTER TABLE earn_split_swap_advisories
  ADD CONSTRAINT earn_split_swap_operation_state_check CHECK (
    (swap_chain_status IS NULL AND swap_signature IS NULL)
    OR (swap_chain_status IS NOT NULL AND swap_chain_status IN ('submitted', 'finalized', 'failed')
        AND swap_signature IS NOT NULL AND unsigned_transaction IS NOT NULL)
  ) NOT VALID;
ALTER TABLE earn_split_swap_advisories
  ADD CONSTRAINT earn_split_swap_operation_slot_check CHECK (
    swap_observed_slot IS NULL OR
    (swap_observed_slot = TRUNC(swap_observed_slot)
     AND swap_observed_slot BETWEEN 0 AND 18446744073709551615)
  ) NOT VALID;
ALTER TABLE earn_split_swap_advisories
  ADD CONSTRAINT earn_split_swap_operation_failure_check CHECK (
    (swap_chain_status = 'failed') = (swap_failure_reason IS NOT NULL)
  ) NOT VALID;
