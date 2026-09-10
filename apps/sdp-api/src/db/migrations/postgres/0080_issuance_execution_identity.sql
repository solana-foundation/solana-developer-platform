-- HOO-1023 K5a: pin Issuance work to one exact SDP wallet row.
-- Provider wallet ids remain rollback evidence. Historical transactions and
-- deployed tokens are intentionally not assigned an inferred signer.

ALTER TABLE issued_tokens
    ADD COLUMN signing_custody_wallet_id TEXT;

ALTER TABLE issuance_transactions
    ADD COLUMN custody_wallet_id TEXT;

CREATE TEMP VIEW issuance_wallet_scope AS
SELECT
    wallet.id,
    wallet.wallet_id,
    config.organization_id,
    config.project_id,
    'config'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_configs config ON config.id = wallet.custody_config_id
UNION ALL
SELECT
    wallet.id,
    wallet.wallet_id,
    connection.organization_id,
    connection.project_id,
    'connection'::TEXT AS owner_kind
FROM custody_wallets wallet
JOIN custody_connections connection ON connection.id = wallet.custody_connection_id;

WITH unique_matches AS (
    SELECT token.id AS token_id, MIN(wallet.id) AS custody_wallet_id
    FROM issued_tokens token
    JOIN issuance_wallet_scope wallet
      ON wallet.organization_id = token.organization_id
     AND (
          (wallet.owner_kind = 'config'
           AND (wallet.project_id = token.project_id OR wallet.project_id IS NULL))
          OR
          (wallet.owner_kind = 'connection' AND wallet.project_id = token.project_id)
     )
     AND wallet.wallet_id = token.signing_wallet_id
    WHERE token.status = 'pending'
      AND token.mint_address IS NULL
      AND token.signing_custody_wallet_id IS NULL
    GROUP BY token.id
    HAVING COUNT(*) = 1
)
UPDATE issued_tokens token
SET signing_custody_wallet_id = unique_matches.custody_wallet_id
FROM unique_matches
WHERE token.id = unique_matches.token_id
  AND token.signing_custody_wallet_id IS NULL;

DROP VIEW issuance_wallet_scope;

ALTER TABLE issued_tokens
    ADD CONSTRAINT issued_tokens_signing_custody_wallet_id_fkey
        FOREIGN KEY (signing_custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

ALTER TABLE issuance_transactions
    ADD CONSTRAINT issuance_transactions_custody_wallet_id_fkey
        FOREIGN KEY (custody_wallet_id)
        REFERENCES custody_wallets(id)
        ON DELETE NO ACTION;

CREATE INDEX idx_issued_tokens_signing_custody_wallet_id
    ON issued_tokens(signing_custody_wallet_id, created_at DESC)
    WHERE signing_custody_wallet_id IS NOT NULL;

CREATE INDEX idx_issuance_transactions_custody_wallet_id
    ON issuance_transactions(custody_wallet_id, created_at DESC)
    WHERE custody_wallet_id IS NOT NULL;
