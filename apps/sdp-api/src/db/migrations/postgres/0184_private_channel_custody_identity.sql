-- Resolve all custody matches before taking any ADD COLUMN lock.
-- Late old-writer rows remain nullable and are proved by runtime reads.
CREATE TEMP TABLE private_channel_verified_wallet_custody_matches ON COMMIT DROP AS
WITH wallet_scope AS (
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, config.organization_id, config.project_id
    FROM custody_wallets wallet
    JOIN custody_configs config ON config.id = wallet.custody_config_id
    UNION ALL
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, connection.organization_id, connection.project_id
    FROM custody_wallets wallet
    JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
)
SELECT verification.id, verification.organization_id, verification.project_id,
       verification.wallet_id, verification.pubkey, MIN(wallet.id) AS custody_wallet_id
FROM private_channel_verified_wallets verification
JOIN wallet_scope wallet
  ON wallet.organization_id = verification.organization_id
 AND wallet.project_id = verification.project_id
 AND wallet.wallet_id = verification.wallet_id
 AND wallet.public_key = verification.pubkey
GROUP BY verification.id, verification.organization_id, verification.project_id,
         verification.wallet_id, verification.pubkey
HAVING COUNT(*) = 1;

CREATE TEMP TABLE private_channel_deposit_custody_matches ON COMMIT DROP AS
WITH wallet_scope AS (
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, config.organization_id, config.project_id
    FROM custody_wallets wallet
    JOIN custody_configs config ON config.id = wallet.custody_config_id
    UNION ALL
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, connection.organization_id, connection.project_id
    FROM custody_wallets wallet
    JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
)
SELECT deposit.id, deposit.organization_id, deposit.project_id,
       deposit.wallet_id, deposit.depositor, MIN(wallet.id) AS custody_wallet_id
FROM private_channel_deposits deposit
JOIN wallet_scope wallet
  ON wallet.organization_id = deposit.organization_id
 AND wallet.project_id = deposit.project_id
 AND wallet.wallet_id = deposit.wallet_id
 AND wallet.public_key = deposit.depositor
GROUP BY deposit.id, deposit.organization_id, deposit.project_id,
         deposit.wallet_id, deposit.depositor
HAVING COUNT(*) = 1;

CREATE TEMP TABLE private_channel_withdrawal_custody_matches ON COMMIT DROP AS
WITH wallet_scope AS (
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, config.organization_id, config.project_id
    FROM custody_wallets wallet
    JOIN custody_configs config ON config.id = wallet.custody_config_id
    UNION ALL
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, connection.organization_id, connection.project_id
    FROM custody_wallets wallet
    JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
)
SELECT withdrawal.id, withdrawal.organization_id, withdrawal.project_id,
       withdrawal.wallet_id, withdrawal.owner, MIN(wallet.id) AS custody_wallet_id
FROM private_channel_withdrawals withdrawal
JOIN wallet_scope wallet
  ON wallet.organization_id = withdrawal.organization_id
 AND wallet.project_id = withdrawal.project_id
 AND wallet.wallet_id = withdrawal.wallet_id
 AND wallet.public_key = withdrawal.owner
GROUP BY withdrawal.id, withdrawal.organization_id, withdrawal.project_id,
         withdrawal.wallet_id, withdrawal.owner
HAVING COUNT(*) = 1;

CREATE TEMP TABLE private_channel_transfer_custody_matches ON COMMIT DROP AS
WITH wallet_scope AS (
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, config.organization_id, config.project_id
    FROM custody_wallets wallet
    JOIN custody_configs config ON config.id = wallet.custody_config_id
    UNION ALL
    SELECT wallet.id, wallet.wallet_id, wallet.public_key, connection.organization_id, connection.project_id
    FROM custody_wallets wallet
    JOIN custody_connections connection ON connection.id = wallet.custody_connection_id
)
SELECT transfer.id, transfer.organization_id, transfer.project_id,
       transfer.sender_wallet_id, transfer.sender, MIN(wallet.id) AS custody_wallet_id
FROM private_channel_transfers transfer
JOIN wallet_scope wallet
  ON wallet.organization_id = transfer.organization_id
 AND wallet.project_id = transfer.project_id
 AND wallet.wallet_id = transfer.sender_wallet_id
 AND wallet.public_key = transfer.sender
GROUP BY transfer.id, transfer.organization_id, transfer.project_id,
         transfer.sender_wallet_id, transfer.sender
HAVING COUNT(*) = 1;

-- Let lock contention reach the runner's retry before the statement budget expires.
SET LOCAL lock_timeout = '2s';
-- Bound each statement while the schema locks are held.
SET LOCAL statement_timeout = '5s';

ALTER TABLE private_channel_verified_wallets ADD COLUMN custody_wallet_id TEXT;

-- A previous writer may change the evidence while the lookup runs.
UPDATE private_channel_verified_wallets verification
SET custody_wallet_id = matches.custody_wallet_id
FROM private_channel_verified_wallet_custody_matches matches
WHERE verification.id = matches.id
  AND verification.custody_wallet_id IS NULL
  AND verification.organization_id = matches.organization_id
  AND verification.project_id = matches.project_id
  AND verification.wallet_id = matches.wallet_id
  AND verification.pubkey = matches.pubkey;

DROP TABLE private_channel_verified_wallet_custody_matches;

ALTER TABLE private_channel_deposits ADD COLUMN custody_wallet_id TEXT;

-- A previous writer may change the evidence while the lookup runs.
UPDATE private_channel_deposits deposit
SET custody_wallet_id = matches.custody_wallet_id
FROM private_channel_deposit_custody_matches matches
WHERE deposit.id = matches.id
  AND deposit.custody_wallet_id IS NULL
  AND deposit.organization_id = matches.organization_id
  AND deposit.project_id = matches.project_id
  AND deposit.wallet_id = matches.wallet_id
  AND deposit.depositor = matches.depositor;

DROP TABLE private_channel_deposit_custody_matches;

ALTER TABLE private_channel_withdrawals ADD COLUMN custody_wallet_id TEXT;

-- A previous writer may change the evidence while the lookup runs.
UPDATE private_channel_withdrawals withdrawal
SET custody_wallet_id = matches.custody_wallet_id
FROM private_channel_withdrawal_custody_matches matches
WHERE withdrawal.id = matches.id
  AND withdrawal.custody_wallet_id IS NULL
  AND withdrawal.organization_id = matches.organization_id
  AND withdrawal.project_id = matches.project_id
  AND withdrawal.wallet_id = matches.wallet_id
  AND withdrawal.owner = matches.owner;

DROP TABLE private_channel_withdrawal_custody_matches;

ALTER TABLE private_channel_transfers ADD COLUMN custody_wallet_id TEXT;

-- A previous writer may change the evidence while the lookup runs.
UPDATE private_channel_transfers transfer
SET custody_wallet_id = matches.custody_wallet_id
FROM private_channel_transfer_custody_matches matches
WHERE transfer.id = matches.id
  AND transfer.custody_wallet_id IS NULL
  AND transfer.organization_id = matches.organization_id
  AND transfer.project_id = matches.project_id
  AND transfer.sender_wallet_id = matches.sender_wallet_id
  AND transfer.sender = matches.sender;

DROP TABLE private_channel_transfer_custody_matches;
