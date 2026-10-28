-- Why SDP paused a recurring payment (HOO-2340): `custody_policy_refused` when the custody
-- provider's policy refused to sign a collection, `failed_attempts` when one due period failed
-- too many times (RECURRING_PAYMENT_PAUSE_REASONS in @sdp/types/payments). It is set exactly
-- while the row is `paused`: the pause writes it and resume and cancel clear it. Nothing writes
-- `paused` before this revision serves, so no row needs a reason. The column is nullable with
-- no default, so adding it rewrites nothing; both CHECKs go on NOT VALID so the add takes no
-- blocking scan, and 0185 validates them.
ALTER TABLE payment_recurring_payments
    ADD COLUMN paused_reason TEXT,
    ADD CONSTRAINT payment_recurring_payments_paused_reason_check
        CHECK (paused_reason IN ('custody_policy_refused', 'failed_attempts')) NOT VALID,
    ADD CONSTRAINT payment_recurring_payments_paused_reason_status_check
        CHECK ((status = 'paused') = (paused_reason IS NOT NULL)) NOT VALID;
