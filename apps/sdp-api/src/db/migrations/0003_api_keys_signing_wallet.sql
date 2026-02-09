-- Add API-key scoped signing wallet binding.

ALTER TABLE api_keys ADD COLUMN signing_wallet_id TEXT;

CREATE INDEX idx_api_keys_signing_wallet_id ON api_keys(signing_wallet_id);

