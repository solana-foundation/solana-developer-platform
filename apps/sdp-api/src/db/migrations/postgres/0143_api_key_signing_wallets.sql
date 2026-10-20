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
-- A key's list is its 'active' rows, replaced with the key row in one audited
-- transaction. A wallet taken off the list is archived, never deleted, and
-- listing it again reactivates its row.
--
-- api_key_wallet_permissions and api_keys.signing_wallet_id are no longer read
-- or written; a later migration drops them.
ALTER TABLE api_keys
  ADD COLUMN IF NOT EXISTS wallet_scope TEXT NOT NULL DEFAULT 'all'
  CHECK (wallet_scope IN ('all', 'selected'));

CREATE TABLE api_key_signing_wallets (
  api_key_id TEXT NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  custody_wallet_id TEXT NOT NULL REFERENCES custody_wallets(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
  archived_at TEXT,
  CHECK ((status = 'archived') = (archived_at IS NOT NULL)),
  PRIMARY KEY (api_key_id, custody_wallet_id)
);

-- backfill:start
-- A key that was wallet-bound stays bound: without this every bound key would
-- read as 'all' and sign with any wallet in its project. Fails closed. A
-- binding carries over only if it could sign every module with that wallet
-- before ('*', or the NULL historical unrestricted marker): a module-specific
-- one such as "custody:write" or "tokens:write" signed some modules only, and
-- the new list is not per module. Its provider wallet id must also name
-- exactly one custody wallet in the key's project. A key left with none
-- listed signs nothing until a person picks its wallets again.
UPDATE api_keys ak
   SET wallet_scope = 'selected'
 WHERE ak.wallet_scope = 'all'
   AND (ak.signing_wallet_id IS NOT NULL
        OR EXISTS (SELECT 1 FROM api_key_wallet_permissions b WHERE b.api_key_id = ak.id));

INSERT INTO api_key_signing_wallets (api_key_id, custody_wallet_id)
SELECT b.api_key_id, min(w.id)
  FROM api_key_wallet_permissions b
  JOIN api_keys ak ON ak.id = b.api_key_id
  JOIN custody_wallets w ON w.wallet_id = b.wallet_id
  LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
  LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
 WHERE ((cfg.organization_id = ak.organization_id AND cfg.project_id = ak.project_id)
     OR (conn.organization_id = ak.organization_id AND conn.project_id = ak.project_id))
   AND (b.permissions IS NULL
        OR b.permissions LIKE '%"*"%')
 GROUP BY b.api_key_id, b.wallet_id
HAVING count(DISTINCT w.id) = 1
ON CONFLICT DO NOTHING;
-- backfill:end

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
-- Their index builds concurrently in 0144.

-- An update that changes where or how much money moves records its caller as
-- the activator when it claims the payment. The activator it replaced is kept
-- on the attempt as {apiKeyId, userId}, and an attempt abandoned before the
-- new terms take effect puts it back. NULL: the attempt changed no activator.
ALTER TABLE payment_recurring_payment_update_attempts
  ADD COLUMN IF NOT EXISTS previous_activator JSONB;
