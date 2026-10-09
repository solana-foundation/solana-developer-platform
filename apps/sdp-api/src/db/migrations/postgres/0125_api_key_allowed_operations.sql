-- Allowed Operations (ADR 0006, HOO-1889): the operation families and types an
-- API key may perform on the custody wallets it can access. JSON array of
-- strings, like `permissions` and `allowed_ips`. NULL or `[]` means the key is
-- unrestricted, which is also what every existing key starts as.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_operations TEXT;
