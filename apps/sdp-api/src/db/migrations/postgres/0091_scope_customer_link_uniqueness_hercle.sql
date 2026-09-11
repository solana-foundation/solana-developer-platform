-- Hercle creates one sub-account per counterparty and routes its verification
-- webhook by that account id (provider_customer_reference) — the BVNK shape,
-- not the buyer-owned MoonPay one — so its customer links join the scoped
-- uniqueness that 0082 narrowed to bvnk/lightspark.
DROP INDEX IF EXISTS idx_counterparty_provider_accounts_customer_link_reference;

CREATE UNIQUE INDEX idx_counterparty_provider_accounts_customer_link_reference
ON counterparty_provider_accounts(provider, provider_customer_reference)
WHERE status = 'active'
  AND kind = 'customer_link'
  AND provider IN ('bvnk', 'lightspark', 'hercle')
  AND provider_customer_reference IS NOT NULL;
