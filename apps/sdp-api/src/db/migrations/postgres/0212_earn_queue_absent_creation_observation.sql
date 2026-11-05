-- Older unknown_signature_observed_at values only prove a status-cache miss.
-- A create may fail after expiry only with two spaced, complete observations:
-- absent status, finalized transaction, provider PDA and provider close history.
-- Keep this nullable expansion compatible with the previously serving image.
ALTER TABLE earn_vault_withdrawal_request_actions
  ADD COLUMN IF NOT EXISTS absent_creation_observed_at TEXT;
