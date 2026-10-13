-- Additive recurring identity storage. Retain provider projections and all
-- existing transaction evidence; catch-up is a separately scoped operation.
ALTER TABLE payment_subscription_plans
    ADD COLUMN owner_custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE NO ACTION,
    ADD COLUMN puller_custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE NO ACTION;

CREATE INDEX idx_payment_subscription_plans_owner_custody_wallet
    ON payment_subscription_plans(owner_custody_wallet_id)
    WHERE owner_custody_wallet_id IS NOT NULL;

CREATE INDEX idx_payment_subscription_plans_puller_custody_wallet
    ON payment_subscription_plans(puller_custody_wallet_id)
    WHERE puller_custody_wallet_id IS NOT NULL;
