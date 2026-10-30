-- The revokes an activation or update attempt's first claim saw on its wallets (HOO-2339), as
-- {wallets: [{walletAddress, environment, revocations}]}. A stale attempt's recovery claims again
-- but checks its authority setup and subscribe against this fence, not a fresh count, so an
-- incident revoke claimed after the original claim stops the recovery too. NULL on an attempt
-- claimed before this revision: its recovery fences from its own claim, as before. Nullable with
-- no default, so neither add rewrites its table.
ALTER TABLE payment_recurring_payment_activation_attempts
  ADD COLUMN IF NOT EXISTS revoke_fence JSONB;
ALTER TABLE payment_recurring_payment_update_attempts
  ADD COLUMN IF NOT EXISTS revoke_fence JSONB;
