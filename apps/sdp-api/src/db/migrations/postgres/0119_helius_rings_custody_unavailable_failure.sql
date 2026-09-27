-- Helius Rings: admit `custody_unavailable` into the failure vocabulary.
--
-- A Rings operation is signed through the wallet's recorded custody wallet,
-- and its runtime admission refuses to sign while that connection is paused,
-- otherwise unavailable, or not entitled on this tier. Nothing signed and
-- nothing broke — but the refusal was previously recorded as `signer_failed`
-- (reads as a signer bug) or collapsed at the gateway boundary into
-- `invalid_input`/`gateway_unavailable` (reads as a malformed request or a
-- Rings outage). The row has to name custody as the unavailable part: no
-- retry recovers it, only resuming the connection or moving the tier does.

-- DROP + ADD rather than a conditional rewrite: the runner keys
-- schema_migrations on the file name, so this pair is idempotent under
-- re-runs and never leaves an older value list behind.
ALTER TABLE helius_rings_operations
    DROP CONSTRAINT IF EXISTS helius_rings_operations_failure_code_check;

ALTER TABLE helius_rings_operations
    ADD CONSTRAINT helius_rings_operations_failure_code_check
        CHECK (failure_code IS NULL OR failure_code IN (
            'policy_denied',
            'approval_rejected',
            'proof_failed',
            'signer_failed',
            'provider_unsupported',
            'custody_unavailable',
            'submit_failed',
            'indexing_timeout',
            'gateway_unavailable',
            'config_error',
            'invalid_input',
            'insufficient_balance',
            'manual_reconciliation_required'
        ));
