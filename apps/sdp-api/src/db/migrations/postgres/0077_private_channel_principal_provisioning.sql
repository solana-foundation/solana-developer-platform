-- 0073 was already recorded by some environments before `provisioned_at` was
-- added to that migration. Reconcile those databases without replaying or
-- rewriting migration history.

ALTER TABLE private_channel_users
    ADD COLUMN IF NOT EXISTS provisioned_at TEXT;

UPDATE private_channel_users
   SET provisioned_at = COALESCE(accepted_at, created_at)
 WHERE provisioned_at IS NULL
   AND spc_username IS NOT NULL
   AND spc_credential_ciphertext IS NOT NULL;
