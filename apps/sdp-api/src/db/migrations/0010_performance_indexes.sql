-- Add composite indexes for the hottest filtered + ordered queries.

CREATE INDEX IF NOT EXISTS idx_org_members_org_status_created
  ON organization_members(organization_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_org_members_org_role_created
  ON organization_members(organization_id, role, created_at);

CREATE INDEX IF NOT EXISTS idx_invitations_org_email_status
  ON invitations(organization_id, email, status);

CREATE INDEX IF NOT EXISTS idx_api_keys_org_created
  ON api_keys(organization_id, created_at);

CREATE INDEX IF NOT EXISTS idx_sessions_user_revoked_created
  ON sessions(user_id, revoked_at, created_at);

CREATE INDEX IF NOT EXISTS idx_api_key_wallet_permissions_key_created
  ON api_key_wallet_permissions(api_key_id, created_at);

CREATE INDEX IF NOT EXISTS idx_issued_tokens_project_created
  ON issued_tokens(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_issued_tokens_project_status_created
  ON issued_tokens(project_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_issuance_tx_token_created
  ON issuance_transactions(token_id, created_at);

CREATE INDEX IF NOT EXISTS idx_issuance_tx_token_status_created
  ON issuance_transactions(token_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_token_allowlist_token_status_created
  ON token_allowlists(token_id, status, created_at);

CREATE INDEX IF NOT EXISTS idx_frozen_accounts_token_frozen_active
  ON frozen_accounts(token_id, frozen_at)
  WHERE unfrozen_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_custody_configs_org_project_status_updated
  ON custody_configs(organization_id, project_id, status, updated_at);

CREATE INDEX IF NOT EXISTS idx_custody_wallets_config_status
  ON custody_wallets(custody_config_id, status);

CREATE INDEX IF NOT EXISTS idx_custody_wallets_config_purpose_status
  ON custody_wallets(custody_config_id, purpose, status);

CREATE INDEX IF NOT EXISTS idx_payment_transfers_status_updated
  ON payment_transfers(status, updated_at);
