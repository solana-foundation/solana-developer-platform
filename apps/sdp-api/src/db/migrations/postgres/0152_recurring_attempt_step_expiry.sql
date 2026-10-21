-- Each recurring attempt row keeps the expiry of its step in flight (HOO-2188).
--
-- A step's signature is saved before its send. Recovery can prove a saved send
-- will never land only once the chain's block height is past the
-- last_valid_block_height of the blockhash it was signed with, and a compiled
-- message carries only the blockhash, so the height is stored beside the
-- signature. One column per row is enough: a flow has at most one step in
-- flight, and earlier steps have landed before the next one saves.
--
-- The activation authority-setup signature moves out of metadata into its own
-- column, matching update attempts. The metadata key stays until no running
-- revision reads it.
--
-- The CHECKs scan, and the backfill holds the ADD COLUMN lock until commit, on
-- tables production has never written (the platform is pre-launch).

-- Solana's u64 counters (block heights, slots, nonces). SCALE rejects a
-- fraction that NUMERIC(20, 0) would silently round.
CREATE DOMAIN sdp_u64 AS NUMERIC
    CHECK (SCALE(VALUE) = 0 AND VALUE BETWEEN 0 AND 18446744073709551615);

ALTER TABLE payment_recurring_payment_activation_attempts
    ADD COLUMN IF NOT EXISTS authorization_setup_signature TEXT,
    ADD COLUMN IF NOT EXISTS last_valid_block_height sdp_u64;

UPDATE payment_recurring_payment_activation_attempts
SET authorization_setup_signature = metadata->>'authorizationSetupSignature'
WHERE metadata ? 'authorizationSetupSignature'
  AND authorization_setup_signature IS NULL;

ALTER TABLE payment_recurring_payment_activation_attempts
    ADD CONSTRAINT payment_recurring_activation_attempts_expiry_signature_check
    CHECK (
        last_valid_block_height IS NULL
        OR plan_creation_signature IS NOT NULL
        OR authorization_setup_signature IS NOT NULL
        OR authorization_signature IS NOT NULL
    );

ALTER TABLE payment_recurring_payment_update_attempts
    ADD COLUMN IF NOT EXISTS last_valid_block_height sdp_u64;

ALTER TABLE payment_recurring_payment_update_attempts
    ADD CONSTRAINT payment_recurring_update_attempts_expiry_signature_check
    CHECK (
        last_valid_block_height IS NULL
        OR plan_update_signature IS NOT NULL
        OR plan_creation_signature IS NOT NULL
        OR authorization_setup_signature IS NOT NULL
        OR authorization_signature IS NOT NULL
        OR old_cancel_signature IS NOT NULL
    );

ALTER TABLE payment_recurring_payment_lifecycle_attempts
    ADD COLUMN IF NOT EXISTS last_valid_block_height sdp_u64;

ALTER TABLE payment_recurring_payment_lifecycle_attempts
    ADD CONSTRAINT payment_recurring_lifecycle_attempts_expiry_signature_check
    CHECK (last_valid_block_height IS NULL OR signature IS NOT NULL);
