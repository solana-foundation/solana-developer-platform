-- Solana Earn: durable scheduling for long-lived queued withdrawals.
--
-- A pending request cannot become fulfillable before its provider-authenticated
-- maturity. Polling every open request on every minute tick therefore spends
-- provider and RPC capacity without improving customer-visible convergence.
-- `next_check_at` is both the due time and the short worker lease: a claim moves
-- it forward before releasing its row lock, and a successful observation
-- schedules the next useful read.

ALTER TABLE earn_vault_withdrawal_requests
    ADD COLUMN IF NOT EXISTS next_check_at TEXT;

-- Existing open work remains immediately due after rollout. Terminal rows do
-- not participate in this queue and keep the column null.
UPDATE earn_vault_withdrawal_requests
   SET next_check_at = COALESCE(last_checked_at, updated_at, sdp_iso_now())
 WHERE status IN (
    'creating', 'pending', 'fulfillable', 'expired_cancelable',
    'cancelling', 'closed_or_unknown'
 )
   AND next_check_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_earn_vault_withdrawal_requests_next_check
    ON earn_vault_withdrawal_requests(COALESCE(next_check_at, updated_at), id)
    WHERE status IN (
        'creating', 'pending', 'fulfillable', 'expired_cancelable',
        'cancelling', 'closed_or_unknown'
    );
