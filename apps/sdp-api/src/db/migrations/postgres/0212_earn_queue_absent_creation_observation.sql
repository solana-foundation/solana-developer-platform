-- Older unknown_signature_observed_at values only prove a status-cache miss.
-- A create may fail after expiry only with two spaced, complete observations:
-- absent status, finalized transaction, provider PDA and provider close history.
-- Keep this nullable expansion compatible with the previously serving image.
ALTER TABLE earn_vault_withdrawal_request_actions
  ADD COLUMN IF NOT EXISTS absent_creation_observed_at TEXT;

-- NULL preserves uncertainty for rows written by older images. New creates
-- explicitly start FALSE; observing an open provider request makes it TRUE.
ALTER TABLE earn_vault_withdrawal_requests
  ADD COLUMN IF NOT EXISTS provider_state_observed BOOLEAN;

-- Capture observations from the previous image too, while both images serve
-- traffic. Closing an account must never erase a durable existence proof.
CREATE OR REPLACE FUNCTION earn_retain_provider_observation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.provider_state_observed IS TRUE
    OR OLD.status IN (
      'pending', 'fulfillable', 'expired_cancelable',
      'cancelling', 'fulfilled', 'cancelled'
    )
    OR NEW.status IN (
      'pending', 'fulfillable', 'expired_cancelable',
      'cancelling', 'fulfilled', 'cancelled'
    )
  THEN
    NEW.provider_state_observed := TRUE;
  ELSIF OLD.status = 'creating' AND OLD.provider_state_observed IS NULL THEN
    NEW.provider_state_observed := FALSE;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE TRIGGER earn_retain_provider_observation
BEFORE UPDATE OF status ON earn_vault_withdrawal_requests
FOR EACH ROW EXECUTE FUNCTION earn_retain_provider_observation();
