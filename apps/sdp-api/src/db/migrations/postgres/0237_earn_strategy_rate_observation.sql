-- Existing update timestamps do not prove when a provider's rate was observed.
-- Nullable for preexisting observations and older images during a rollout.
ALTER TABLE earn_strategies ADD COLUMN rate_observed_at TEXT;

-- The previous revision can still update APY while this migration is live.
-- A changed rate without a new observation must not inherit an older rate's
-- timestamp. Metadata-only writes retain the original observation.
CREATE FUNCTION retain_earn_rate_observation() RETURNS trigger AS $$
BEGIN
  IF NEW.current_apy IS NULL OR (
    NEW.current_apy IS DISTINCT FROM OLD.current_apy
    AND NEW.rate_observed_at IS NOT DISTINCT FROM OLD.rate_observed_at
  ) THEN
    NEW.rate_observed_at := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER earn_strategy_rate_observation_guard
BEFORE UPDATE ON earn_strategies
FOR EACH ROW EXECUTE FUNCTION retain_earn_rate_observation();
