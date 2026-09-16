-- Every issued token now opens in the Asset Profile management workspace.
-- Backfill the minimal editable profile for tokens created before that became
-- an invariant. The partial unique index makes the NOT EXISTS predicate safe
-- to rerun while retaining archived profile history.
WITH extension_settings AS (
    SELECT
        token_id,
        jsonb_object_agg(setting_key, setting_value) AS selected
    FROM (
        SELECT
            token_id,
            CASE extension
                WHEN 'pausable' THEN 'pauseTransfers'
                WHEN 'permanentDelegate' THEN 'permanentDelegate'
                WHEN 'transferFee' THEN 'transferFee'
                WHEN 'interestBearing' THEN 'interestBearing'
                WHEN 'scaledUiAmount' THEN 'scaledUiAmount'
                WHEN 'transferHook' THEN 'transferHook'
                WHEN 'nonTransferable' THEN 'nonTransferable'
            END AS setting_key,
            CASE extension
                WHEN 'transferFee' THEN jsonb_build_object(
                    'params',
                    jsonb_strip_nulls(jsonb_build_object(
                        'basisPoints', config_json -> 'basisPoints',
                        'maxFee', config_json -> 'maxFee'
                    ))
                )
                WHEN 'interestBearing' THEN jsonb_build_object(
                    'params',
                    jsonb_strip_nulls(jsonb_build_object('rate', config_json -> 'rate'))
                )
                WHEN 'scaledUiAmount' THEN jsonb_build_object(
                    'params',
                    jsonb_build_object(
                        'multiplier',
                        COALESCE(config_json -> 'multiplier', '1'::jsonb)
                    )
                )
                WHEN 'transferHook' THEN jsonb_build_object(
                    'params',
                    jsonb_strip_nulls(jsonb_build_object('programId', config_json -> 'programId'))
                )
                ELSE '{}'::jsonb
            END AS setting_value
        FROM (
            SELECT
                token_id,
                extension,
                COALESCE(config::jsonb, '{}'::jsonb) AS config_json
            FROM issued_token_extensions
            WHERE extension IN (
                'pausable',
                'permanentDelegate',
                'transferFee',
                'interestBearing',
                'scaledUiAmount',
                'transferHook',
                'nonTransferable'
            )
        ) AS extensions
    ) AS settings
    GROUP BY token_id
), profile_sources AS (
    SELECT
        token.*,
        COALESCE(extension_settings.selected, '{}'::jsonb) ||
            CASE
                WHEN token.freeze_authority_enabled = 1
                    THEN jsonb_build_object('freezeAccounts', '{}'::jsonb)
                ELSE '{}'::jsonb
            END AS selected_settings
    FROM issued_tokens AS token
    LEFT JOIN extension_settings ON extension_settings.token_id = token.id
)
INSERT INTO asset_profiles (
    id,
    organization_id,
    project_id,
    token_id,
    asset_category,
    asset_type,
    asset_type_version,
    issuance_metadata,
    public_metadata,
    status,
    created_by,
    created_at,
    updated_at
)
SELECT
    'asset_profile_' || gen_random_uuid(),
    token.organization_id,
    token.project_id,
    token.id,
    CASE
        WHEN token.template = 'stablecoin' THEN 'stablecoin'
        WHEN token.template IN ('tokenized-security', 'rwa') THEN 'tokenized_security'
        ELSE 'generic'
    END,
    'generic',
    2,
    jsonb_build_object(
        'asset',
        jsonb_build_object('name', token.name) ||
            CASE
                WHEN token.description IS NOT NULL
                    THEN jsonb_build_object('description', token.description)
                ELSE '{}'::jsonb
            END,
        'chain', jsonb_build_object('decimals', token.decimals)
    ) ||
    CASE
        WHEN token.selected_settings <> '{}'::jsonb THEN
            jsonb_build_object(
                'settings',
                jsonb_build_object('version', 1, 'selected', token.selected_settings)
            )
        ELSE '{}'::jsonb
    END,
    CASE
        WHEN token.template = 'stablecoin' THEN
            jsonb_build_object(
                'asset', jsonb_build_object('name', token.name),
                'chain', jsonb_build_object('decimals', token.decimals)
            )
        WHEN token.template IN ('tokenized-security', 'rwa') THEN
            jsonb_build_object('asset', jsonb_build_object('name', token.name))
        ELSE
            jsonb_build_object(
                'asset',
                jsonb_build_object('name', token.name) ||
                    CASE
                        WHEN token.description IS NOT NULL
                            THEN jsonb_build_object('description', token.description)
                        ELSE '{}'::jsonb
                    END
            )
    END,
    'active',
    token.created_by,
    token.created_at,
    token.updated_at
FROM profile_sources AS token
WHERE NOT EXISTS (
    SELECT 1
    FROM asset_profiles AS profile
    WHERE profile.token_id = token.id
      AND profile.status = 'active'
);
