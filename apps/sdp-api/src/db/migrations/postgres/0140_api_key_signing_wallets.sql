-- Wallet scope at signing (HOO-2099; APE-390, APE-343).
--
-- An API key's wallet scope is explicit: 'all' signs from any custody wallet
-- in its project, 'selected' signs only from the custody wallets listed in
-- api_key_signing_wallets. A selected key with no listed wallet signs nothing;
-- it never widens to 'all', because the scope is a column, not inferred from
-- whether rows exist.
--
-- The list names custody_wallets.id, the immutable row id, never the
-- provider wallet_id: a provider id reused by another row can no longer pick
-- up a key's grant (APE-390). The foreign key (NO ACTION, checked at the end of
-- the statement) keeps a wallet a key may sign with from disappearing under
-- it; custody wallets are retired by status, and the signing waist refuses an
-- inactive row anyway.
--
-- The rows are a key's current list, replaced with the key row in one audited
-- transaction, so the table has no status column of its own: its history is
-- the audit log.
--
-- api_key_wallet_permissions and api_keys.signing_wallet_id are no longer read
-- or written; a later migration drops them.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS wallet_scope TEXT NOT NULL DEFAULT 'all'
  CHECK (wallet_scope IN ('all', 'selected'));

CREATE TABLE IF NOT EXISTS api_key_signing_wallets (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id),
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  PRIMARY KEY (api_key_id, custody_wallet_id)
);

-- The foreign-key check on a custody wallet's deletion looks rows up by wallet.
CREATE INDEX IF NOT EXISTS idx_api_key_signing_wallets_custody_wallet
  ON api_key_signing_wallets(custody_wallet_id);

-- As visible as the key it belongs to (0081's child-table policy).
ALTER TABLE api_key_signing_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_key_signing_wallets FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_tenant_isolation ON api_key_signing_wallets;
CREATE POLICY sdp_tenant_isolation ON api_key_signing_wallets
  USING (
    sdp_tenant_isolation_is_privileged()
    OR EXISTS (SELECT 1 FROM api_keys parent WHERE parent.id = api_key_signing_wallets.api_key_id)
  )
  WITH CHECK (
    sdp_tenant_isolation_is_privileged()
    OR EXISTS (SELECT 1 FROM api_keys parent WHERE parent.id = api_key_signing_wallets.api_key_id)
  );

-- Who activated (or last resumed) a recurring payment, for audit and for the
-- "revoke this key and cancel what it activated" path (APE-343). Scheduled
-- collection runs as the mandate itself, never as this principal, so a key's
-- revocation does not stop the mandates it activated. Exactly one is set once
-- activated; both stay NULL before activation.
ALTER TABLE payment_recurring_payments
  ADD COLUMN IF NOT EXISTS activated_by_api_key_id TEXT,
  ADD COLUMN IF NOT EXISTS activated_by_user_id TEXT;

CREATE INDEX IF NOT EXISTS idx_payment_recurring_payments_activated_by_api_key
  ON payment_recurring_payments(activated_by_api_key_id)
  WHERE activated_by_api_key_id IS NOT NULL;
