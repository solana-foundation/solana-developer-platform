-- Counterparty provider accounts: normalized links between a counterparty and
-- its provider-side customer identity (PRO-1752, MoonPay first). Replaces
-- provider_data blob traversal for provider customer references.
--
-- UNIQUE is (counterparty_id, provider) only: a provider-side customer (e.g. a
-- MoonPay account deduped by email) may legitimately back multiple
-- counterparties, so (provider, provider_customer_reference) is a plain lookup index.

CREATE TABLE IF NOT EXISTS counterparty_provider_accounts (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    counterparty_id TEXT NOT NULL REFERENCES counterparties(id),
    provider TEXT NOT NULL,
    provider_customer_reference TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    CONSTRAINT counterparty_provider_accounts_counterparty_provider_unique
        UNIQUE (counterparty_id, provider)
);

CREATE INDEX IF NOT EXISTS idx_counterparty_provider_accounts_customer_reference
    ON counterparty_provider_accounts(provider, provider_customer_reference);
