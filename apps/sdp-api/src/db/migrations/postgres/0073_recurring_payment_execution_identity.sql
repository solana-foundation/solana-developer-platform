-- HOO-1023: pin each recurring payment to one exact SDP wallet row.
-- Retained wallet history participates in the exactly-one backfill; wallet
-- status is intentionally not part of identity resolution.

ALTER TABLE payment_recurring_payments
    ADD COLUMN source_custody_wallet_id TEXT;

ALTER TABLE payment_recurring_payment_update_attempts
    ADD COLUMN new_source_custody_wallet_id TEXT;

CREATE TEMP VIEW recurring_wallet_scope AS
SELECT
    wallet.id,
    wallet.wallet_id,
    wallet.public_key,
    config.organization_id,
    config.project_id,
    'config'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_configs config ON config.id = wallet.custody_config_id
UNION ALL
SELECT
    wallet.id,
    wallet.wallet_id,
    wallet.public_key,
    connection.organization_id,
    connection.project_id,
    'connection'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_connections connection ON connection.id = wallet.custody_connection_id;

WITH unique_matches AS (
    SELECT recurring.id AS recurring_payment_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_recurring_payments recurring
    JOIN recurring_wallet_scope wallet
      ON wallet.organization_id = recurring.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = recurring.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = recurring.project_id)
     )
     AND wallet.wallet_id = recurring.source_wallet_id
     AND wallet.public_key = recurring.source_address
    GROUP BY recurring.id
    HAVING COUNT(*) = 1
)
UPDATE payment_recurring_payments recurring
SET source_custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE recurring.id = unique_matches.recurring_payment_id
  AND recurring.source_custody_wallet_id IS NULL;

DROP VIEW recurring_wallet_scope;

ALTER TABLE payment_recurring_payments
    ADD CONSTRAINT payment_recurring_payments_source_custody_wallet_id_fkey
        FOREIGN KEY (source_custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

ALTER TABLE payment_recurring_payment_update_attempts
    ADD CONSTRAINT payment_recurring_updates_new_source_custody_wallet_id_fkey
        FOREIGN KEY (new_source_custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

CREATE INDEX idx_payment_recurring_payments_source_custody_wallet_id
    ON payment_recurring_payments(
        source_custody_wallet_id,
        organization_id,
        project_id,
        created_at DESC
    )
    WHERE source_custody_wallet_id IS NOT NULL;

CREATE INDEX idx_recurring_updates_new_source_custody_wallet_id
    ON payment_recurring_payment_update_attempts(new_source_custody_wallet_id)
    WHERE new_source_custody_wallet_id IS NOT NULL;
