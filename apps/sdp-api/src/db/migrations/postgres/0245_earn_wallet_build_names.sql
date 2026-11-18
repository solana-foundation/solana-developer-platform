-- Canonical wallet build names share the existing storage, ledger references,
-- constraints and triggers. Physical earn_external_wallet_* names remain only
-- so the previous serving revision and already-recorded builds keep working.
-- security_invoker retains the caller's table grants and tenant RLS policies.
CREATE VIEW earn_wallet_transactions WITH (security_invoker = true) AS
    SELECT * FROM earn_external_wallet_transactions;

CREATE VIEW earn_wallet_withdrawal_request_transactions
    WITH (security_invoker = true) AS
    SELECT * FROM earn_external_wallet_withdrawal_request_transactions;
