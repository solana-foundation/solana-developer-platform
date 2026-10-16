-- Observed payouts are identified by withdrawal_request_id, never by a caller's
-- command idempotency key. Keep the existing initiated-movement indexes and
-- ON CONFLICT targets intact for the previous API revision during rollout.
ALTER TABLE earn_movements ALTER COLUMN request_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION earn_observed_payout_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.withdrawal_request_id IS NOT NULL THEN
    NEW.request_id := NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- Also normalize the previous revision's writer, which still supplies the
-- request's client key when it inserts an observed payout.
CREATE OR REPLACE TRIGGER earn_observed_payout_key
BEFORE INSERT OR UPDATE ON earn_movements
FOR EACH ROW EXECUTE FUNCTION earn_observed_payout_key();

-- Existing settled rows keep their legacy keys until updated. No historical
-- economic data is rewritten during this expansion.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conrelid = 'earn_movements'::regclass
      AND conname = 'earn_movements_command_key_check') THEN
    ALTER TABLE earn_movements ADD CONSTRAINT earn_movements_command_key_check
      CHECK (request_id IS NOT NULL OR withdrawal_request_id IS NOT NULL);
  END IF;
END;
$$;
