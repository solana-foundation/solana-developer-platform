-- Custody scoped-configuration integrity (HOO-1004).
--
-- 1. Org-level custody_configs (project_id IS NULL) were exempt from the
--    per-scope UNIQUE constraint because NULLs compare distinct, so
--    concurrent writers could create duplicate scope rows. Deduplicate and
--    re-create the constraint NULLS NOT DISTINCT.
-- 2. default_wallet_id was a free-text pointer with no referential
--    integrity; pin it to a wallet owned by the same config.

-- Deduplicate org-level configs per (organization_id, provider): keep the
-- most recently updated active row, repoint references, and move the
-- duplicates' wallets to the survivor.
CREATE TEMP TABLE custody_config_duplicates ON COMMIT DROP AS
SELECT id, keep_id
FROM (
    SELECT
        id,
        FIRST_VALUE(id) OVER (
            PARTITION BY organization_id, provider
            ORDER BY (status = 'active') DESC, updated_at DESC, id
        ) AS keep_id
    FROM custody_configs
    WHERE project_id IS NULL
) ranked
WHERE id <> keep_id;

UPDATE custody_scope_defaults sd
SET default_custody_config_id = dup.keep_id
FROM custody_config_duplicates dup
WHERE sd.default_custody_config_id = dup.id;

UPDATE signing_requests sr
SET custody_config_id = dup.keep_id
FROM custody_config_duplicates dup
WHERE sr.custody_config_id = dup.id;

-- Move each duplicate's wallets to the survivor unless the survivor already
-- holds the same provider wallet id (one candidate per wallet id).
UPDATE custody_wallets w
SET custody_config_id = dup.keep_id
FROM custody_config_duplicates dup
WHERE w.custody_config_id = dup.id
  AND w.id IN (
      SELECT DISTINCT ON (inner_dup.keep_id, inner_w.wallet_id) inner_w.id
      FROM custody_wallets inner_w
      JOIN custody_config_duplicates inner_dup
        ON inner_dup.id = inner_w.custody_config_id
      WHERE NOT EXISTS (
          SELECT 1
          FROM custody_wallets kept
          WHERE kept.custody_config_id = inner_dup.keep_id
            AND kept.wallet_id = inner_w.wallet_id
      )
      ORDER BY
          inner_dup.keep_id,
          inner_w.wallet_id,
          (inner_w.status = 'active') DESC,
          inner_w.created_at,
          inner_w.id
  );

-- Wallets that could not move (the survivor already holds the same provider
-- wallet id) will cascade away with their config. Repoint their dependents
-- at the survivor's copy first so policies, API-key bindings, and operation
-- history are preserved rather than cascaded or nulled.
CREATE TEMP TABLE custody_wallet_duplicates ON COMMIT DROP AS
SELECT dup_w.id, kept.id AS keep_id
FROM custody_wallets dup_w
JOIN custody_config_duplicates dup ON dup.id = dup_w.custody_config_id
JOIN custody_wallets kept
  ON kept.custody_config_id = dup.keep_id
 AND kept.wallet_id = dup_w.wallet_id;

-- One active control profile per wallet: non-active profiles always move;
-- an active profile keeps its active status only if the survivor's wallet
-- has none (one candidate per survivor).
UPDATE wallet_control_profiles wcp
SET custody_wallet_id = wdup.keep_id
FROM custody_wallet_duplicates wdup
WHERE wcp.custody_wallet_id = wdup.id
  AND (
      wcp.status <> 'active'
      OR wcp.id IN (
          SELECT DISTINCT ON (wd.keep_id) inner_wcp.id
          FROM wallet_control_profiles inner_wcp
          JOIN custody_wallet_duplicates wd ON inner_wcp.custody_wallet_id = wd.id
          WHERE inner_wcp.status = 'active'
            AND NOT EXISTS (
                SELECT 1
                FROM wallet_control_profiles kept_wcp
                WHERE kept_wcp.custody_wallet_id = wd.keep_id
                  AND kept_wcp.status = 'active'
            )
          ORDER BY wd.keep_id, inner_wcp.updated_at DESC, inner_wcp.id
      )
  );

-- Active profiles that lost the active slot still move — demoted to
-- 'disabled' so the policy and its revisions survive for operator review
-- instead of silently cascade-deleting with the duplicate wallet (which
-- would leave repointed API-key bindings governed by a weaker profile with
-- no trace of the stricter one).
DO $$
DECLARE
    demoted_profile_count BIGINT;
BEGIN
    UPDATE wallet_control_profiles wcp
    SET custody_wallet_id = wdup.keep_id,
        status = 'disabled',
        updated_at = sdp_iso_now()
    FROM custody_wallet_duplicates wdup
    WHERE wcp.custody_wallet_id = wdup.id
      AND wcp.status = 'active';

    GET DIAGNOSTICS demoted_profile_count = ROW_COUNT;
    IF demoted_profile_count > 0 THEN
        RAISE NOTICE 'Demoted % active wallet control profile(s) to disabled during custody config dedup; the surviving wallet already had an active profile — review and merge manually', demoted_profile_count;
    END IF;
END;
$$;

-- The selected-binding unique index is on (api_key_id, wallet_id), and the
-- duplicate shares the survivor's wallet_id, so repointing cannot collide.
UPDATE api_key_wallet_policy_bindings b
SET custody_wallet_id = wdup.keep_id
FROM custody_wallet_duplicates wdup
WHERE b.custody_wallet_id = wdup.id;

UPDATE wallet_operations op
SET custody_wallet_id = wdup.keep_id
FROM custody_wallet_duplicates wdup
WHERE op.custody_wallet_id = wdup.id;

DELETE FROM custody_configs c
USING custody_config_duplicates dup
WHERE c.id = dup.id;

-- One config per (organization, project, provider), org-level rows included.
ALTER TABLE custody_configs
    DROP CONSTRAINT custody_configs_organization_id_project_id_provider_key;

ALTER TABLE custody_configs
    ADD CONSTRAINT custody_configs_org_project_provider_key
        UNIQUE NULLS NOT DISTINCT (organization_id, project_id, provider);

-- Repair defaults pointing at wallets the config does not own, then enforce
-- ownership going forward. DEFERRABLE INITIALLY DEFERRED so a cascade delete
-- of a config together with its wallets validates at commit, and so a config
-- upsert and its wallet insert can land in either order within one
-- transaction.
UPDATE custody_configs c
SET default_wallet_id = NULL
WHERE c.default_wallet_id IS NOT NULL
  AND NOT EXISTS (
      SELECT 1
      FROM custody_wallets w
      WHERE w.custody_config_id = c.id
        AND w.wallet_id = c.default_wallet_id
  );

ALTER TABLE custody_configs
    ADD CONSTRAINT custody_configs_default_wallet_fkey
        FOREIGN KEY (id, default_wallet_id)
        REFERENCES custody_wallets(custody_config_id, wallet_id)
        DEFERRABLE INITIALLY DEFERRED;
