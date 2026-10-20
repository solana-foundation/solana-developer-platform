-- sdp:migration-compat: breaking
-- Each collection attempt keeps the delegation's state from just before its
-- pull was signed (HOO-2194).
--
-- The delegation account alone cannot prove a pull landed: after the first
-- pull, amount_pulled_in_period equals the amount both before and after every
-- later pull, and only current_period_start_ts moving tells them apart. The
-- pair read at confirmed, before signing, lets recovery compare the delegation
-- against its pre-image. current_period_start_ts is an i64 on chain;
-- amount_pulled_in_period is a u64.
--
-- Rows written before this migration carry neither value. An in-flight attempt
-- with a signature but no pre-image could never resolve and would block its
-- schedule, so it fails here; its payment_transfers row is left to the generic
-- transfer tracker, which owns it. The CHECK scans, and the UPDATE touches, a
-- table production has never written (the platform is pre-launch).

ALTER TABLE payment_subscription_collection_attempts
    ADD COLUMN IF NOT EXISTS delegation_period_start_ts_before BIGINT,
    ADD COLUMN IF NOT EXISTS delegation_amount_pulled_before sdp_u64;

ALTER TABLE payment_subscription_collection_attempts
    ADD CONSTRAINT payment_subscription_collection_attempts_pre_image_check
    CHECK (
        (delegation_period_start_ts_before IS NULL) = (delegation_amount_pulled_before IS NULL)
    );

UPDATE payment_subscription_collection_attempts
   SET status = 'failed',
       error = 'Collection attempt predates the delegation pre-image (migration 0153)',
       updated_at = sdp_iso_now()
 WHERE status IN ('pending', 'processing')
   AND signature IS NOT NULL
   AND delegation_period_start_ts_before IS NULL;
