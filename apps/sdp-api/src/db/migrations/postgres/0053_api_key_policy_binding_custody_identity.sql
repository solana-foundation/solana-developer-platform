WITH unique_wallet_matches AS (
    SELECT
        binding.id AS binding_id,
        MIN(wallet.id) AS custody_wallet_id
    FROM api_key_wallet_policy_bindings binding
    JOIN api_keys api_key
      ON api_key.id = binding.api_key_id
    JOIN custody_configs config
      ON config.organization_id = api_key.organization_id
     AND (
          config.project_id IS NULL
          OR api_key.project_id IS NULL
          OR config.project_id = api_key.project_id
     )
     AND config.status = 'active'
    JOIN custody_wallets wallet
      ON wallet.custody_config_id = config.id
     AND wallet.wallet_id = binding.wallet_id
     AND wallet.status = 'active'
    WHERE binding.binding_scope = 'selected'
      AND binding.custody_wallet_id IS NULL
    GROUP BY binding.id
    HAVING COUNT(*) = 1
)
UPDATE api_key_wallet_policy_bindings binding
SET custody_wallet_id = unique_wallet_matches.custody_wallet_id
FROM unique_wallet_matches
WHERE binding.id = unique_wallet_matches.binding_id;

DO $$
DECLARE
    deleted_binding_count BIGINT;
BEGIN
    DELETE FROM api_key_wallet_policy_bindings
    WHERE binding_scope = 'selected'
      AND custody_wallet_id IS NULL;

    GET DIAGNOSTICS deleted_binding_count = ROW_COUNT;
    RAISE NOTICE 'Deleted % unresolved selected API key wallet policy bindings', deleted_binding_count;
END;
$$;

ALTER TABLE api_key_wallet_policy_bindings
    DROP CONSTRAINT api_key_wallet_policy_bindings_wallet_check;

ALTER TABLE api_key_wallet_policy_bindings
    ADD CONSTRAINT api_key_wallet_policy_bindings_wallet_check
    CHECK (
        (binding_scope = 'all' AND wallet_id IS NULL AND custody_wallet_id IS NULL)
        OR (
            binding_scope = 'selected'
            AND wallet_id IS NOT NULL
            AND custody_wallet_id IS NOT NULL
        )
    );

DROP INDEX idx_api_key_wallet_policy_bindings_selected;

CREATE UNIQUE INDEX idx_api_key_wallet_policy_bindings_selected
    ON api_key_wallet_policy_bindings(api_key_id, custody_wallet_id)
    WHERE binding_scope = 'selected';
