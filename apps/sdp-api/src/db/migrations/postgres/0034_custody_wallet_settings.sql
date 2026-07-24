ALTER TABLE custody_wallets
ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;
