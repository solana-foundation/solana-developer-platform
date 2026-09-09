-- Serialize add-new payout submissions: at most one incomplete reservation per
-- corridor and rail. Concurrent submissions otherwise race the archive/insert
-- sweep and can complete two active payout identities for one corridor.
-- Existing incomplete reservations are archived first — they are unlinked at
-- the provider and the next submission mints a fresh identity anyway.

UPDATE counterparty_provider_accounts
SET status = 'archived',
    updated_at = sdp_iso_now()
WHERE status = 'active'
  AND external_account_reference IS NULL
  AND payment_rail IS NOT NULL;

CREATE UNIQUE INDEX counterparty_provider_accounts_pending_reservation_unique
    ON counterparty_provider_accounts(
        counterparty_id,
        provider,
        fiat_currency,
        destination_country,
        payment_rail
    )
    WHERE status = 'active'
      AND external_account_reference IS NULL
      AND payment_rail IS NOT NULL;
