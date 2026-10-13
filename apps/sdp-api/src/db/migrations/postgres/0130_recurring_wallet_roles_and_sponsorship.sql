-- Additive recurring identity storage. Retain provider projections and all
-- existing transaction evidence; catch-up is a separately scoped operation.
ALTER TABLE payment_subscription_plans
    ADD COLUMN owner_custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE NO ACTION,
    ADD COLUMN puller_custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE NO ACTION,
    ADD COLUMN role_projection_revision BIGINT NOT NULL DEFAULT 0;

CREATE INDEX idx_payment_subscription_plans_owner_custody_wallet
    ON payment_subscription_plans(owner_custody_wallet_id)
    WHERE owner_custody_wallet_id IS NOT NULL;

CREATE INDEX idx_payment_subscription_plans_puller_custody_wallet
    ON payment_subscription_plans(puller_custody_wallet_id)
    WHERE puller_custody_wallet_id IS NOT NULL;

-- UPDATE OF also fences an old writer's same-value PATCH: equal addresses
-- cannot prove that two managed wallet records are the same role.
CREATE OR REPLACE FUNCTION sdp_fence_subscription_plan_roles()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
    IF ((OLD.owner_custody_wallet_id IS NOT NULL OR OLD.puller_custody_wallet_id IS NOT NULL)
        AND OLD.role_projection_revision = 0)
       OR ((OLD.owner_custody_wallet_id IS NOT NULL
        OR OLD.puller_custody_wallet_id IS NOT NULL
        OR NEW.owner_custody_wallet_id IS NOT NULL
        OR NEW.puller_custody_wallet_id IS NOT NULL)
       AND NEW.role_projection_revision <= OLD.role_projection_revision) THEN
        RAISE EXCEPTION 'Subscription plan roles require a compatible identity writer'
            USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER subscription_plan_role_writer_fence
BEFORE UPDATE OF owner_wallet_id, owner_address, puller_wallet_id, puller_address,
                 owner_custody_wallet_id, puller_custody_wallet_id
ON payment_subscription_plans
FOR EACH ROW EXECUTE FUNCTION sdp_fence_subscription_plan_roles();
