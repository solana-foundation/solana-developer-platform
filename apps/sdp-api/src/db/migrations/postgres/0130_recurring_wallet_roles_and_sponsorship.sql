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

-- A stage can contain setup and authorization messages with distinct budget
-- reservations. The domain attempt and concrete message own each link.
CREATE TABLE payment_recurring_sponsorship_links (
    recurring_payment_id TEXT NOT NULL REFERENCES payment_recurring_payments(id) ON DELETE NO ACTION,
    organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE NO ACTION,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE NO ACTION,
    attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('activation', 'lifecycle', 'update', 'collection')),
    attempt_id TEXT NOT NULL,
    message_key TEXT NOT NULL,
    deployment_mode TEXT NOT NULL CHECK (deployment_mode IN ('managed', 'self_hosted')),
    legacy_actor_id TEXT NOT NULL,
    custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id) ON DELETE NO ACTION,
    reservation_id TEXT REFERENCES sponsorship_budget_reservations(id) ON DELETE NO ACTION,
    accounting_identity JSONB,
    admission_started_at TIMESTAMPTZ,
    confirmed_failure_signature TEXT,
    submission_signature TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (attempt_kind, attempt_id, message_key),
    CHECK ((reservation_id IS NULL) = (accounting_identity IS NULL)),
    CHECK (accounting_identity IS NULL OR deployment_mode = 'managed'),
    CHECK (accounting_identity IS NULL OR jsonb_typeof(accounting_identity) = 'object')
);

CREATE INDEX payment_recurring_sponsorship_links_domain_idx
    ON payment_recurring_sponsorship_links(organization_id, project_id, recurring_payment_id, attempt_kind, message_key);

ALTER TABLE payment_recurring_sponsorship_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_recurring_sponsorship_links FORCE ROW LEVEL SECURITY;
CREATE POLICY sdp_tenant_isolation ON payment_recurring_sponsorship_links
    USING (sdp_tenant_isolation_allows(organization_id))
    WITH CHECK (sdp_tenant_isolation_allows(organization_id));
