-- Validate the token-movement CHECKs added NOT VALID (ADR 0012).
--
-- 0184 (payment request expectations), 0185 (recurring mandates) and 0186
-- (a leg's `verified_by` and its chain-verified reasons) added these CHECKs
-- NOT VALID, so the add did not scan rows written before it. Every row
-- written since is checked, and the rows before have none of the new columns
-- or `verified_by`'s default, which each CHECK allows. A VALIDATE takes a
-- SHARE UPDATE EXCLUSIVE lock: reads and writes continue while it scans. It
-- runs in a later migration than the adds, as check:migration-compat
-- requires.
--
-- Deploy only after the previous revisions' migrations (0184-0186) are in
-- production past their rollback window: a rollback past them would let an
-- older revision write rows these CHECKs refuse.

ALTER TABLE payment_requests
    VALIDATE CONSTRAINT payment_requests_expectation_shape;

ALTER TABLE payment_recurring_payments
    VALIDATE CONSTRAINT payment_recurring_payments_mandate_shape;

ALTER TABLE payment_subscription_plans
    VALIDATE CONSTRAINT payment_subscription_plans_mandate_shape;

ALTER TABLE token_movement_legs
    VALIDATE CONSTRAINT token_movement_legs_verified_by_known;

ALTER TABLE token_movement_legs
    VALIDATE CONSTRAINT token_movement_legs_verification_reason_known;
