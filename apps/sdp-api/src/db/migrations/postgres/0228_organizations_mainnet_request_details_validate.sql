-- Validates 0227's check in a later migration, so the scan of organizations runs without the lock
-- that adding it would hold.
ALTER TABLE organizations VALIDATE CONSTRAINT organizations_mainnet_request_details_check;
