-- HOO-1023 K3: persist the exact SDP wallet row used by Payments execution.
-- Provider wallet ids and addresses remain evidence; only exactly-one retained
-- in-scope matches are backfilled. No wallet status filter is intentional.

ALTER TABLE payment_transfers
    ADD COLUMN custody_wallet_id TEXT;

ALTER TABLE payment_transfer_batches
    ADD COLUMN source_custody_wallet_id TEXT;

ALTER TABLE payment_requests
    ADD COLUMN custody_wallet_id TEXT;

CREATE TEMP VIEW k3_payments_wallet_scope AS
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
    SELECT transfer.id AS transfer_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_transfers transfer
    JOIN k3_payments_wallet_scope wallet
      ON wallet.organization_id = transfer.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = transfer.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = transfer.project_id)
     )
     AND wallet.wallet_id = transfer.wallet_id
     AND wallet.public_key = CASE
          WHEN transfer.direction = 'inbound' THEN transfer.destination_address
          ELSE transfer.source_address
     END
    WHERE transfer.custody_wallet_id IS NULL
    GROUP BY transfer.id
    HAVING COUNT(*) = 1
)
UPDATE payment_transfers transfer
SET custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE transfer.id = unique_matches.transfer_id
  AND transfer.custody_wallet_id IS NULL;

WITH unique_matches AS (
    SELECT batch.id AS batch_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_transfer_batches batch
    JOIN k3_payments_wallet_scope wallet
      ON wallet.organization_id = batch.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = batch.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = batch.project_id)
     )
     AND wallet.wallet_id = batch.source_wallet_id
     AND wallet.public_key = batch.source_address
    WHERE batch.source_custody_wallet_id IS NULL
    GROUP BY batch.id
    HAVING COUNT(*) = 1
)
UPDATE payment_transfer_batches batch
SET source_custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE batch.id = unique_matches.batch_id
  AND batch.source_custody_wallet_id IS NULL;

WITH unique_matches AS (
    SELECT request.id AS request_id, MIN(wallet.id) AS custody_wallet_id
    FROM payment_requests request
    JOIN k3_payments_wallet_scope wallet
      ON wallet.organization_id = request.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = request.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = request.project_id)
     )
     AND wallet.wallet_id = request.wallet_id
     AND wallet.public_key = request.destination_address
    WHERE request.custody_wallet_id IS NULL
    GROUP BY request.id
    HAVING COUNT(*) = 1
)
UPDATE payment_requests request
SET custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE request.id = unique_matches.request_id
  AND request.custody_wallet_id IS NULL;

DROP VIEW k3_payments_wallet_scope;

ALTER TABLE wallet_operations
    DROP CONSTRAINT wallet_operations_custody_wallet_id_fkey,
    ADD CONSTRAINT wallet_operations_custody_wallet_id_fkey
        FOREIGN KEY (custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

ALTER TABLE payment_transfers
    ADD CONSTRAINT payment_transfers_custody_wallet_id_fkey
        FOREIGN KEY (custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

ALTER TABLE payment_transfer_batches
    ADD CONSTRAINT payment_transfer_batches_source_custody_wallet_id_fkey
        FOREIGN KEY (source_custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

ALTER TABLE payment_requests
    ADD CONSTRAINT payment_requests_custody_wallet_id_fkey
        FOREIGN KEY (custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

CREATE INDEX idx_payment_transfers_custody_wallet_id
    ON payment_transfers(custody_wallet_id, created_at DESC)
    WHERE custody_wallet_id IS NOT NULL;

CREATE INDEX idx_payment_transfer_batches_source_custody_wallet_id
    ON payment_transfer_batches(source_custody_wallet_id, created_at DESC)
    WHERE source_custody_wallet_id IS NOT NULL;

CREATE INDEX idx_payment_requests_custody_wallet_id
    ON payment_requests(custody_wallet_id, created_at DESC)
    WHERE custody_wallet_id IS NOT NULL;
