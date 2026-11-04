-- When the provider reported a customer link's provider_status: its event's own time, or when SDP sent the read that returned it.
-- A provider's status webhook can be applied late or replayed from the inbox after a newer report.
-- The link keeps the newest report, so an older one never undoes it. NULL means no ordered report yet, and any report replaces it.
ALTER TABLE counterparty_provider_accounts
  ADD COLUMN IF NOT EXISTS provider_status_observed_at TEXT;
