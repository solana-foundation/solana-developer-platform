-- Signer checks left the wallet-operation ledger (they are metered at the
-- route instead) and older rows can carry retired operation types such as
-- transfer_prepare. Historical rows are kept for audit; anything still in
-- flight under a retired vocabulary is canceled (the 0055 pattern) so pending
-- approvals resolve visibly instead of vanishing with a cascade delete.
UPDATE approval_requests ar
SET status = 'canceled',
    resolved_at = sdp_iso_now(),
    updated_at = sdp_iso_now()
FROM wallet_operations wo
WHERE ar.wallet_operation_id = wo.id
  AND ar.status = 'pending'
  AND (
    wo.operation_family NOT IN ('transfer', 'payment', 'ramp', 'issuance')
    OR wo.operation_type NOT IN (
        'issuance_burn_execute',
        'issuance_force_burn_execute',
        'issuance_mint_execute',
        'issuance_seize_execute',
        'issuance_update_authority_execute',
        'payment_transfer_batch_execute',
        'payment_transfer_execute',
        'ramp_offramp_quote',
        'ramp_onramp_quote',
        'recurring_payment_collection',
        'recurring_payment_create',
        'recurring_payment_update'
    )
  );

UPDATE wallet_operations
SET status = 'canceled',
    updated_at = sdp_iso_now()
WHERE status IN ('created', 'evaluated', 'pending_approval', 'executing')
  AND (
    operation_family NOT IN ('transfer', 'payment', 'ramp', 'issuance')
    OR operation_type NOT IN (
        'issuance_burn_execute',
        'issuance_force_burn_execute',
        'issuance_mint_execute',
        'issuance_seize_execute',
        'issuance_update_authority_execute',
        'payment_transfer_batch_execute',
        'payment_transfer_execute',
        'ramp_offramp_quote',
        'ramp_onramp_quote',
        'recurring_payment_collection',
        'recurring_payment_create',
        'recurring_payment_update'
    )
  );

-- NOT VALID keeps the retired historical rows readable while constraining
-- every new or updated row to the live families. Retired rows are terminal
-- after the cancels above, so they are never updated again.
ALTER TABLE wallet_operations
    DROP CONSTRAINT wallet_operations_family_check;

ALTER TABLE wallet_operations
    ADD CONSTRAINT wallet_operations_family_check
        CHECK (operation_family IN ('transfer', 'payment', 'ramp', 'issuance'))
        NOT VALID;
