-- An organization's one-time request for mainnet (HOO-2427): the jurisdiction it declares (its
-- primary registered geography for business), the SDP Terms and Conditions version an admin
-- accepted, and when the SDP alias was told. Approval stays the `enableProductionProject`
-- entitlement an operator sets in Clerk; these columns never grant anything. An admin writes them
-- once; afterwards only the operator script (`pnpm -C apps/sdp-api mainnet-access`) changes them.
-- Nullable: no existing organization has asked. The constraints are added NOT VALID so they take no
-- blocking scan of organizations; 0193 validates them.
ALTER TABLE organizations
    ADD COLUMN jurisdiction_country_code TEXT,
    ADD COLUMN terms_accepted_version TEXT,
    ADD COLUMN terms_accepted_at TEXT,
    ADD COLUMN terms_accepted_by_user_id TEXT,
    ADD COLUMN mainnet_requested_at TEXT,
    ADD COLUMN mainnet_requested_by_user_id TEXT,
    -- Set once the alias accepted the email; a request without it is resent on the next submit.
    ADD COLUMN mainnet_request_notified_at TEXT;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_jurisdiction_country_code_check
    CHECK (jurisdiction_country_code ~ '^[A-Z]{2}$')
    NOT VALID;

-- Terms are accepted as a whole, and a request carries its jurisdiction and acceptance.
ALTER TABLE organizations
    ADD CONSTRAINT organizations_terms_acceptance_whole
    CHECK (
        (terms_accepted_version IS NULL) = (terms_accepted_at IS NULL)
        AND (terms_accepted_version IS NULL) = (terms_accepted_by_user_id IS NULL)
    )
    NOT VALID;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_mainnet_request_whole
    CHECK (
        mainnet_requested_at IS NULL
        OR (
            mainnet_requested_by_user_id IS NOT NULL
            AND jurisdiction_country_code IS NOT NULL
            AND terms_accepted_version IS NOT NULL
        )
    )
    NOT VALID;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_terms_accepted_by_user_id_fkey
    FOREIGN KEY (terms_accepted_by_user_id) REFERENCES users(id)
    NOT VALID;

ALTER TABLE organizations
    ADD CONSTRAINT organizations_mainnet_requested_by_user_id_fkey
    FOREIGN KEY (mainnet_requested_by_user_id) REFERENCES users(id)
    NOT VALID;
