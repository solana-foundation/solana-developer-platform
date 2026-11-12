-- Two optional answers on an organization's mainnet access request (PRO-2481): the requester's
-- contact at the Solana Foundation (an @solana.org address the API checks) and one short line on
-- what the organization builds. Both only inform the reviewer; approval stays the
-- `enableProductionProject` entitlement in Clerk. Nullable: a request without them, and every
-- request made before this migration, has neither. The check is added NOT VALID so it takes no
-- blocking scan of organizations; 0228 validates it.
ALTER TABLE organizations
    ADD COLUMN mainnet_foundation_contact_email TEXT,
    ADD COLUMN mainnet_use_case TEXT;

-- The answers belong to a request, and the line stays as short as the API allows.
ALTER TABLE organizations
    ADD CONSTRAINT organizations_mainnet_request_details_check
    CHECK (
        (mainnet_requested_at IS NOT NULL
            OR (mainnet_foundation_contact_email IS NULL AND mainnet_use_case IS NULL))
        AND (mainnet_use_case IS NULL OR char_length(mainnet_use_case) BETWEEN 1 AND 150)
    )
    NOT VALID;
