-- Validates 0192's constraints in a later migration, so the scan of organizations runs without
-- the lock that adding them would hold.
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_jurisdiction_country_code_check;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_terms_acceptance_whole;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_mainnet_request_whole;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_terms_accepted_by_user_id_fkey;
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_mainnet_requested_by_user_id_fkey;
