-- An organization's one-time request for mainnet (HOO-2427): the jurisdiction it declares (its
-- primary registered geography for business), the SDP Terms and Conditions version the admin
-- accepted with the request, and when the SDP alias was told. The request is the acceptance: the
-- same admin, at the same time. Approval stays the `enableProductionProject` entitlement an
-- operator sets in Clerk; these columns never grant anything. An admin writes them once;
-- afterwards only the operator script (`pnpm -C apps/sdp-api mainnet-access`) changes them.
-- Nullable: no existing organization has asked. The constraints are added NOT VALID so they take no
-- blocking scan of organizations; 0194 validates them.
ALTER TABLE organizations
    ADD COLUMN jurisdiction_country_code TEXT,
    ADD COLUMN terms_accepted_version TEXT,
    ADD COLUMN mainnet_requested_at TEXT,
    ADD COLUMN mainnet_requested_by_user_id TEXT,
    -- Set once the alias accepted the email; until then the request can be sent again.
    ADD COLUMN mainnet_request_notified_at TEXT;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_jurisdiction_country_code_check
    CHECK (jurisdiction_country_code ~ '^[A-Z]{2}$')
    NOT VALID;

-- A request carries its requester, jurisdiction and accepted terms, and nothing exists without it.
ALTER TABLE organizations
    ADD CONSTRAINT organizations_mainnet_request_whole
    CHECK (
        (mainnet_requested_at IS NULL) = (mainnet_requested_by_user_id IS NULL)
        AND (mainnet_requested_at IS NULL) = (jurisdiction_country_code IS NULL)
        AND (mainnet_requested_at IS NULL) = (terms_accepted_version IS NULL)
        AND (mainnet_requested_at IS NOT NULL OR mainnet_request_notified_at IS NULL)
    )
    NOT VALID;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_mainnet_requested_by_user_id_fkey
    FOREIGN KEY (mainnet_requested_by_user_id) REFERENCES users(id)
    NOT VALID;
