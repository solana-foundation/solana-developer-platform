-- Helius Rings: admit `provider_unsupported` into the failure vocabulary.
--
-- A Rings wallet's shielded keys are re-derived from its owner's custody
-- signature on every use, so the custody provider must sign raw messages and
-- return the same signature every time. Providers that cannot are refused
-- before anything signs. That refusal was previously recorded as
-- `signer_failed`, which reads as an outage an operator should retry; it is
-- neither. A wallet provisioned before its provider left the allowlist fails
-- its operations here, and the row has to say why: nothing recovers this but
-- moving the wallet to a provider that qualifies.

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
            'submit_failed',
            'indexing_timeout',
            'gateway_unavailable',
            'config_error',
            'invalid_input',
            'insufficient_balance',
            'manual_reconciliation_required'
        ));
