-- sdp:migration-locks: blocking
-- Prelaunch demo-only plans and custody wallets are small; no production users exist.
-- Add and populate plan roles from unique retained wallet evidence.
-- Inactive/archived matches prove identity, not operational eligibility.
ALTER TABLE payment_subscription_plans
    ADD COLUMN owner_custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE NO ACTION,
    ADD COLUMN puller_custody_wallet_id TEXT REFERENCES custody_wallets(id) ON DELETE NO ACTION;

CREATE INDEX idx_payment_subscription_plans_owner_custody_wallet
    ON payment_subscription_plans(owner_custody_wallet_id)
    WHERE owner_custody_wallet_id IS NOT NULL;

CREATE INDEX idx_payment_subscription_plans_puller_custody_wallet
    ON payment_subscription_plans(puller_custody_wallet_id)
    WHERE puller_custody_wallet_id IS NOT NULL;

CREATE TEMP VIEW recurring_catchup_wallet_scope AS
SELECT wallet.id, wallet.wallet_id, wallet.public_key,
       config.organization_id, config.project_id
FROM custody_wallets wallet
JOIN custody_configs config ON config.id = wallet.custody_config_id
UNION ALL
SELECT wallet.id, wallet.wallet_id, wallet.public_key,
       connection.organization_id, connection.project_id
FROM custody_wallets wallet
JOIN custody_connections connection ON connection.id = wallet.custody_connection_id;

WITH matches AS (
  SELECT plan.id, plan.organization_id, plan.project_id, plan.owner_wallet_id, plan.owner_address,
         MIN(wallet.id) AS custody_wallet_id
  FROM payment_subscription_plans plan
  JOIN recurring_catchup_wallet_scope wallet
    ON wallet.organization_id = plan.organization_id
   AND wallet.project_id = plan.project_id
   AND wallet.wallet_id = plan.owner_wallet_id
   AND wallet.public_key = plan.owner_address
  WHERE plan.owner_custody_wallet_id IS NULL
  GROUP BY plan.id, plan.organization_id, plan.project_id, plan.owner_wallet_id, plan.owner_address
  HAVING COUNT(*) = 1
)
UPDATE payment_subscription_plans plan
SET owner_custody_wallet_id = matches.custody_wallet_id
FROM matches
WHERE plan.id = matches.id
  AND plan.organization_id = matches.organization_id
  AND plan.project_id = matches.project_id
  AND plan.owner_custody_wallet_id IS NULL
  AND plan.owner_wallet_id = matches.owner_wallet_id
  AND plan.owner_address = matches.owner_address;

WITH matches AS (
  SELECT plan.id, plan.organization_id, plan.project_id, plan.puller_wallet_id, plan.puller_address,
         MIN(wallet.id) AS custody_wallet_id
  FROM payment_subscription_plans plan
  JOIN recurring_catchup_wallet_scope wallet
    ON wallet.organization_id = plan.organization_id
   AND wallet.project_id = plan.project_id
   AND wallet.wallet_id = plan.puller_wallet_id
   AND wallet.public_key = plan.puller_address
  WHERE plan.puller_custody_wallet_id IS NULL
  GROUP BY plan.id, plan.organization_id, plan.project_id, plan.puller_wallet_id, plan.puller_address
  HAVING COUNT(*) = 1
)
UPDATE payment_subscription_plans plan
SET puller_custody_wallet_id = matches.custody_wallet_id
FROM matches
WHERE plan.id = matches.id
  AND plan.organization_id = matches.organization_id
  AND plan.project_id = matches.project_id
  AND plan.puller_custody_wallet_id IS NULL
  AND plan.puller_wallet_id = matches.puller_wallet_id
  AND plan.puller_address = matches.puller_address;

DROP VIEW recurring_catchup_wallet_scope;
