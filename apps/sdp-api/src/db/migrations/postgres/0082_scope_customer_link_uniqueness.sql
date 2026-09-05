-- 0080's customer-link uniqueness originally covered all providers; it only
-- holds for bvnk/lightspark (one customer per counterparty). A MoonPay account
-- is buyer-owned and legitimately links to many counterparties. 0080 is
-- amended in step for databases that never applied it; this re-scopes the ones
-- that already created the broad index.
DROP INDEX IF EXISTS idx_counterparty_provider_accounts_customer_link_reference;

CREATE UNIQUE INDEX idx_counterparty_provider_accounts_customer_link_reference
ON counterparty_provider_accounts(provider, provider_customer_reference)
WHERE status = 'active'
  AND kind = 'customer_link'
  AND provider IN ('bvnk', 'lightspark')
  AND provider_customer_reference IS NOT NULL;
