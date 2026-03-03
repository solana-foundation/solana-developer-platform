ALTER TABLE custody_wallets ADD COLUMN updated_at TEXT;

UPDATE custody_wallets
SET updated_at = COALESCE(updated_at, created_at, STRFTIME('%Y-%m-%dT%H:%M:%fZ','now'))
WHERE updated_at IS NULL;
