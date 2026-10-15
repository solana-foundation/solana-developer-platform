-- sdp:migration-compat: breaking
-- The custody policy engine is gone (HOO-1889, ADR 0006): wallet policies, API
-- key policy profiles and bindings, policy evaluations, approval requests and
-- groups, the wallet_operations ledger and the provider control mapping. Per-key
-- Allowed Operations replaced them (0125_api_key_allowed_operations).
--
-- Merge only after the code that stopped reading these objects is in
-- production and a rollback to an image that still reads them is no longer
-- plausible: the previous image would fail on every query against them.
-- Nothing outside these tables references them, so there is no CASCADE; an
-- unexpected dependent fails the migration instead of being dropped.
--
-- IF EXISTS keeps the statements repeatable for the test that re-applies
-- earlier migrations (0125_custody_project_only.migration.test.ts).
--
-- Not done here, on purpose: helius_rings_operations keeps `approval_required`
-- in its state CHECK and in its in-flight index, and `policy_denied` /
-- `approval_rejected` in its failure_code CHECK. Tightening them cannot be
-- proven safe from this file (rows in production may still hold them) and the
-- shared status lists in @sdp/types must change first.

DROP TABLE IF EXISTS policy_provider_sync_status;
DROP TABLE IF EXISTS policy_evaluations;
DROP TABLE IF EXISTS approval_requests;
DROP TABLE IF EXISTS approval_group_members;
DROP TABLE IF EXISTS approval_groups;
DROP TABLE IF EXISTS wallet_operations;
DROP TABLE IF EXISTS api_key_wallet_policy_bindings;
DROP TABLE IF EXISTS api_key_control_profile_revisions;
DROP TABLE IF EXISTS api_key_control_profiles;
DROP TABLE IF EXISTS wallet_control_profile_revisions;
DROP TABLE IF EXISTS wallet_control_profiles;

-- Written by the policy engine only; no code reads them.
ALTER TABLE helius_rings_operations
    DROP COLUMN IF EXISTS approval_request_id,
    DROP COLUMN IF EXISTS policy_evaluation_id;
