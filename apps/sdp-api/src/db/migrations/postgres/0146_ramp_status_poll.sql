-- When SDP last asked the provider about a ramp transfer (HOO-2040): the status
-- pull's own fair queue, apart from the chain verifier's
-- finalization_last_polled_at so neither queue rotates the other.
ALTER TABLE payment_transfers
  ADD COLUMN IF NOT EXISTS provider_status_last_polled_at TEXT;
