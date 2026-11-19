-- Advisory observations only. Existing revisions ignore these nullable columns.
ALTER TABLE custody_wallets
    ADD COLUMN provider_policy JSONB,
    ADD COLUMN policy_check_claimed_at TIMESTAMPTZ;
