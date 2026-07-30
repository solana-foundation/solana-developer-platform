/**
 * Exact owner projection for custody wallets.
 *
 * Keep every wallet-sensitive caller on this Config-or-Connection ownership
 * seam so no caller can silently substitute a different custody target.
 */
export const CUSTODY_WALLET_OWNER_CTE = `
custody_wallet_owners AS (
  SELECT
    w.id,
    w.custody_config_id,
    w.custody_connection_id,
    w.wallet_id,
    w.public_key,
    w.label,
    w.purpose,
    w.status,
    w.created_at,
    w.updated_at,
    'config'::text AS owner_kind,
    c.id AS owner_id,
    c.organization_id,
    c.project_id,
    c.provider,
    c.status AS owner_status,
    c.status = 'active' AS owner_usable
  FROM custody_wallets w
  JOIN custody_configs c ON c.id = w.custody_config_id

  UNION ALL

  SELECT
    w.id,
    w.custody_config_id,
    w.custody_connection_id,
    w.wallet_id,
    w.public_key,
    w.label,
    w.purpose,
    w.status,
    w.created_at,
    w.updated_at,
    'connection'::text AS owner_kind,
    c.id AS owner_id,
    c.organization_id,
    c.project_id,
    c.provider,
    c.status AS owner_status,
    c.status = 'active'
      AND c.last_check_status = 'success'
      AND pc.status = 'active'
      AND default_wallet.id IS NOT NULL AS owner_usable
  FROM custody_wallets w
  JOIN custody_connections c ON c.id = w.custody_connection_id
  JOIN provider_credentials pc ON pc.id = c.provider_credential_id
  LEFT JOIN custody_wallets default_wallet
    ON default_wallet.id = c.default_custody_wallet_id
   AND default_wallet.custody_connection_id = c.id
   AND default_wallet.status = 'active'
)`;
