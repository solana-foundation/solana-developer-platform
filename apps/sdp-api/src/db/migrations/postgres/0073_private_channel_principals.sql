-- Recast the legacy per-SDP-user Private Channels identity rows as project-scoped
-- principals. The table name and foreign-key column names stay in place for the
-- first migration step so existing operation history remains readable.

ALTER TABLE private_channel_users
    ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE private_channel_users
    ADD COLUMN IF NOT EXISTS instance_id TEXT,
    ADD COLUMN IF NOT EXISTS name TEXT,
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS disabled_at TEXT,
    ADD COLUMN IF NOT EXISTS created_by TEXT,
    ADD COLUMN IF NOT EXISTS provisioned_at TEXT;

UPDATE private_channel_users
   SET provisioned_at = COALESCE(accepted_at, created_at)
 WHERE provisioned_at IS NULL
   AND spc_username IS NOT NULL
   AND spc_credential_ciphertext IS NOT NULL;

UPDATE private_channel_users pcu
   SET instance_id = (
         SELECT pci.id
           FROM private_channel_instances pci
          WHERE pci.organization_id = pcu.organization_id
            AND pci.project_id = pcu.project_id
            AND pci.is_active = TRUE
          ORDER BY pci.created_at DESC, pci.id DESC
          LIMIT 1
       )
 WHERE instance_id IS NULL;

UPDATE private_channel_users pcu
   SET name = COALESCE(
         NULLIF(TRIM(u.name), ''),
         NULLIF(TRIM(u.email), ''),
         'Legacy principal'
       )
  FROM users u
 WHERE pcu.user_id = u.id
   AND pcu.name IS NULL;

UPDATE private_channel_users
   SET name = 'Legacy principal'
 WHERE name IS NULL;

WITH defaults AS (
  SELECT DISTINCT ON (organization_id, project_id, instance_id) id
    FROM private_channel_users
   WHERE instance_id IS NOT NULL
   ORDER BY organization_id, project_id, instance_id, created_at ASC, id ASC
)
UPDATE private_channel_users pcu
   SET is_default = TRUE,
       name = 'Default'
  FROM defaults
 WHERE pcu.id = defaults.id;

-- Legacy rows used a person name or email. Two SDP users can have the same
-- display value, while the new model requires a unique identity name. Keep the
-- first value and suffix only colliding rows. Repeat in the unlikely case that
-- an old display value already equals one of the generated suffixed values.
DO $$
DECLARE
  renamed_count INTEGER;
BEGIN
  LOOP
    WITH duplicate_names AS (
      SELECT id,
             ROW_NUMBER() OVER (
               PARTITION BY organization_id, project_id, instance_id, LOWER(name)
               ORDER BY is_default DESC, created_at ASC, id ASC
             ) AS occurrence
        FROM private_channel_users
       WHERE instance_id IS NOT NULL
         AND disabled_at IS NULL
    )
    UPDATE private_channel_users pcu
       SET name = pcu.name || ' · ' || pcu.id
      FROM duplicate_names duplicates
     WHERE pcu.id = duplicates.id
       AND duplicates.occurrence > 1;

    GET DIAGNOSTICS renamed_count = ROW_COUNT;
    EXIT WHEN renamed_count = 0;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'private_channel_users_instance_id_fkey'
  ) THEN
    ALTER TABLE private_channel_users
      ADD CONSTRAINT private_channel_users_instance_id_fkey
      FOREIGN KEY (instance_id) REFERENCES private_channel_instances(id) ON DELETE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'private_channel_users_created_by_fkey'
  ) THEN
    ALTER TABLE private_channel_users
      ADD CONSTRAINT private_channel_users_created_by_fkey
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS private_channel_principals_default_key
    ON private_channel_users(organization_id, project_id, instance_id)
    WHERE is_default = TRUE AND disabled_at IS NULL AND instance_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS private_channel_principals_name_key
    ON private_channel_users(organization_id, project_id, instance_id, LOWER(name))
    WHERE disabled_at IS NULL AND instance_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS private_channel_principals_instance_created
    ON private_channel_users(instance_id, created_at DESC);

-- A wallet identifies one principal within an SPC instance. Keep the legacy
-- column name for operation-history compatibility; its values are principal ids.
DROP INDEX IF EXISTS idx_private_channel_verified_wallets_user_instance_pubkey;

-- The legacy model allowed one pubkey under multiple SDP users. Preserve one
-- canonical owner per SPC instance so the narrower unique index is migratable.
-- Prefer the default identity, then the earliest verified binding.
WITH ranked_wallets AS (
  SELECT vw.id,
         ROW_NUMBER() OVER (
           PARTITION BY vw.instance_id, vw.pubkey
           ORDER BY COALESCE(pcu.is_default, FALSE) DESC,
                    vw.verified_at ASC,
                    vw.id ASC
         ) AS ownership_rank
    FROM private_channel_verified_wallets vw
    LEFT JOIN private_channel_users pcu ON pcu.id = vw.user_id
   WHERE vw.instance_id IS NOT NULL
)
DELETE FROM private_channel_verified_wallets vw
 USING ranked_wallets ranked
 WHERE vw.id = ranked.id
   AND ranked.ownership_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS private_channel_verified_wallets_instance_pubkey_key
    ON private_channel_verified_wallets(instance_id, pubkey);

-- The invitation endpoint is gone. Remove its lookup index immediately; the
-- nullable legacy columns remain for a later physical table rename migration.
DROP INDEX IF EXISTS private_channel_users_invite_token_key;
