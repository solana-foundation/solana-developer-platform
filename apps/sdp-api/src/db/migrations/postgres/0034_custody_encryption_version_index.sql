CREATE INDEX IF NOT EXISTS idx_custody_configs_legacy_encryption
  ON custody_configs (id)
  WHERE encryption_version = 'sdp-custody-encryption-v1';
