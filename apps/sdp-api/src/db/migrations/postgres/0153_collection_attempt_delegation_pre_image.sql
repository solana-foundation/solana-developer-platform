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
-- Rows written before this migration carry neither value. The CHECK scans a
-- table production has never written (the platform is pre-launch).

ALTER TABLE payment_subscription_collection_attempts
    ADD COLUMN IF NOT EXISTS delegation_period_start_ts_before BIGINT,
    ADD COLUMN IF NOT EXISTS delegation_amount_pulled_before sdp_u64;

ALTER TABLE payment_subscription_collection_attempts
    ADD CONSTRAINT payment_subscription_collection_attempts_pre_image_check
    CHECK (
        (delegation_period_start_ts_before IS NULL) = (delegation_amount_pulled_before IS NULL)
    );
