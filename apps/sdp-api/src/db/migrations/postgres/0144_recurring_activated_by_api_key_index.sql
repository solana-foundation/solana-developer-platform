-- sdp:migration-mode: non-transactional
--
-- Revoke-and-cancel (APE-343) finds the recurring payments a key activated by
-- payment_recurring_payments.activated_by_api_key_id (0143). Partial: most
-- rows were activated by no key, or by a member.
--
-- CONCURRENTLY because payment_recurring_payments is live: a plain build would
-- block activation and collection writes. Split from 0143 because the runner
-- applies a concurrent build outside the migration transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_payment_recurring_payments_activated_by_api_key
  ON payment_recurring_payments(activated_by_api_key_id)
  WHERE activated_by_api_key_id IS NOT NULL;
