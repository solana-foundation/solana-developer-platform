-- 0047_fold_payment_wallet_policies.sql
--
-- Folds the legacy payment_wallet_policies rows into the
-- wallet_control_profiles / wallet_control_profile_revisions foundation
-- introduced by 0010_wallet_api_key_policy_foundations.sql, then drops the
-- legacy table.
--
-- Legacy shapes (see 0001_initial_schema.sql / 0004_payment_wallet_policies.sql):
--   policy_type = 'destination_allowlist' -> {"version":1,"destinationAllowlist":["addr",...]}
--   policy_type = 'transfer_limits'       -> {"version":1,"maxTransferAmount":"123.45","maxDailyAmount":"999"}
--
-- Conversion rules (decided):
--   * "Legacy content" for a wallet = a non-empty destinationAllowlist array
--     and/or a non-null maxTransferAmount. An empty allowlist means no
--     restriction, so it converts to nothing. maxDailyAmount is deliberately
--     dropped -- it has no equivalent wallet_control_profile_revisions rule
--     kind today.
--   * Rows whose policy JSON is malformed, or whose version is not 1, are
--     skipped exactly like the legacy evaluator skipped them.
--   * No wallet_control_profiles row for the wallet -> create one
--     ('Converted wallet policy', status 'active') plus revision 1 with the
--     synthesized rules, default_action 'allow', activated.
--   * A profile with status IN ('active', 'draft') is treated as "the"
--     profile for the wallet (preferring 'active' when both exist).
--     'disabled'/'archived' profiles are left alone -- this migration never
--     silently re-enables a profile an operator turned off.
--   * If that profile has an active revision, only rule kinds missing from
--     it are synthesized (kind='destination' / kind='amount'); if both are
--     already present the wallet is left completely untouched (no new
--     revision, no updated_at bump).
--   * If that profile has no active revision (draft), it is treated like
--     the "no profile" case for rule synthesis and then activated.
--   * Every inserted revision reuses the wallet's existing rules array
--     (rules || synthesized rules) and default_action so nothing already
--     configured is lost.

-- Scoped helper: parse a legacy policy string as jsonb, returning NULL
-- instead of raising for malformed JSON so bad legacy rows are skipped
-- rather than aborting the whole migration. Dropped again below.
CREATE OR REPLACE FUNCTION sdp_fold_wallet_policies_try_parse(policy_text TEXT)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
  RETURN policy_text::jsonb;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$$;

-- One row per legacy policy row, pre-parsed once so every later step reuses
-- the same parse result instead of re-parsing (and re-risking malformed
-- input) repeatedly.
CREATE TEMP TABLE sdp_fold_legacy_policies ON COMMIT DROP AS
SELECT
    custody_wallet_id,
    policy_type,
    sdp_fold_wallet_policies_try_parse(policy) AS parsed
FROM payment_wallet_policies;

-- One row per custody wallet that actually has legacy content worth
-- converting, with the destination allowlist and max transfer amount
-- resolved and its organization/project resolved via
-- custody_wallets -> custody_configs.
CREATE TEMP TABLE sdp_fold_wallet_policy_signals ON COMMIT DROP AS
SELECT
    cw.id AS custody_wallet_id,
    cc.organization_id,
    cc.project_id,
    da.allowlist,
    tl.max_transfer_amount
FROM (SELECT DISTINCT custody_wallet_id FROM sdp_fold_legacy_policies) wallets
JOIN custody_wallets cw ON cw.id = wallets.custody_wallet_id
JOIN custody_configs cc ON cc.id = cw.custody_config_id
LEFT JOIN (
    SELECT custody_wallet_id, jsonb_agg(elem) AS allowlist
    FROM (
        SELECT custody_wallet_id, parsed
        FROM sdp_fold_legacy_policies
        WHERE policy_type = 'destination_allowlist'
          AND parsed IS NOT NULL
          AND parsed ->> 'version' = '1'
          AND jsonb_typeof(parsed -> 'destinationAllowlist') = 'array'
    ) valid_allowlist_rows,
    LATERAL jsonb_array_elements_text(valid_allowlist_rows.parsed -> 'destinationAllowlist') AS elem
    GROUP BY custody_wallet_id
) da ON da.custody_wallet_id = cw.id
LEFT JOIN (
    SELECT custody_wallet_id, parsed ->> 'maxTransferAmount' AS max_transfer_amount
    FROM sdp_fold_legacy_policies
    WHERE policy_type = 'transfer_limits'
      AND parsed IS NOT NULL
      AND parsed ->> 'version' = '1'
      AND parsed ->> 'maxTransferAmount' IS NOT NULL
) tl ON tl.custody_wallet_id = cw.id
WHERE da.allowlist IS NOT NULL OR tl.max_transfer_amount IS NOT NULL;

-- Resolve each signalled wallet's current profile (if any) and, when it has
-- an active revision, that revision's rules/default_action plus the
-- highest revision_number already used.
CREATE TEMP TABLE sdp_fold_wallet_profile_state ON COMMIT DROP AS
SELECT
    s.custody_wallet_id,
    s.organization_id,
    s.project_id,
    s.allowlist,
    s.max_transfer_amount,
    profile.id AS profile_id,
    active_rev.rules AS active_rules,
    active_rev.default_action AS active_default_action,
    COALESCE(rev_stats.max_revision_number, 0) AS max_revision_number
FROM sdp_fold_wallet_policy_signals s
LEFT JOIN LATERAL (
    SELECT id, active_revision_id
    FROM wallet_control_profiles
    WHERE custody_wallet_id = s.custody_wallet_id
      AND status IN ('active', 'draft')
    ORDER BY (status = 'active') DESC, created_at DESC
    LIMIT 1
) profile ON true
LEFT JOIN wallet_control_profile_revisions active_rev
    ON active_rev.id = profile.active_revision_id
LEFT JOIN LATERAL (
    SELECT MAX(revision_number) AS max_revision_number
    FROM wallet_control_profile_revisions
    WHERE profile_id = profile.id
) rev_stats ON true;

-- Final plan: only wallets that genuinely need a write (new profile, or an
-- existing profile missing a rule kind the legacy data implies). Wallets
-- whose active revision already has both kinds are excluded entirely, so
-- they are left completely untouched.
CREATE TEMP TABLE sdp_fold_wallet_plan ON COMMIT DROP AS
SELECT
    st.custody_wallet_id,
    st.organization_id,
    st.project_id,
    st.allowlist,
    st.max_transfer_amount,
    st.profile_id,
    st.active_rules,
    st.active_default_action,
    st.max_revision_number,
    (st.profile_id IS NULL) AS needs_new_profile,
    needs.needs_destination_rule,
    needs.needs_amount_rule,
    CASE
        WHEN st.profile_id IS NULL THEN 'wcp_' || gen_random_uuid()
        ELSE st.profile_id
    END AS resolved_profile_id,
    'wcpr_' || gen_random_uuid() AS new_revision_id
FROM sdp_fold_wallet_profile_state st
CROSS JOIN LATERAL (
    SELECT
        (
            st.allowlist IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(COALESCE(st.active_rules, '[]'::jsonb)) rule
                WHERE rule ->> 'kind' = 'destination'
            )
        ) AS needs_destination_rule,
        (
            st.max_transfer_amount IS NOT NULL
            AND NOT EXISTS (
                SELECT 1
                FROM jsonb_array_elements(COALESCE(st.active_rules, '[]'::jsonb)) rule
                WHERE rule ->> 'kind' = 'amount'
            )
        ) AS needs_amount_rule
) needs
WHERE st.profile_id IS NULL
   OR needs.needs_destination_rule
   OR needs.needs_amount_rule;

-- Create a profile for wallets that had none at all.
INSERT INTO wallet_control_profiles (
    id,
    organization_id,
    project_id,
    custody_wallet_id,
    name,
    status,
    active_revision_id,
    created_by,
    created_at,
    updated_at,
    activated_at
)
SELECT
    plan.resolved_profile_id,
    plan.organization_id,
    plan.project_id,
    plan.custody_wallet_id,
    'Converted wallet policy',
    'active',
    plan.new_revision_id,
    NULL,
    sdp_iso_now(),
    sdp_iso_now(),
    sdp_iso_now()
FROM sdp_fold_wallet_plan plan
WHERE plan.needs_new_profile;

-- Insert the synthesized revision for every planned wallet: the existing
-- rules array (empty for a brand-new profile) plus whichever converted
-- rule kinds were actually missing.
INSERT INTO wallet_control_profile_revisions (
    id,
    profile_id,
    revision_number,
    rules,
    default_action,
    created_by,
    created_at,
    activated_at
)
SELECT
    plan.new_revision_id,
    plan.resolved_profile_id,
    plan.max_revision_number + 1,
    COALESCE(plan.active_rules, '[]'::jsonb)
        || CASE
               WHEN plan.needs_destination_rule THEN jsonb_build_array(
                   jsonb_build_object(
                       'id', 'converted-destination-allowlist',
                       'kind', 'destination',
                       'allowlist', plan.allowlist
                   )
               )
               ELSE '[]'::jsonb
           END
        || CASE
               WHEN plan.needs_amount_rule THEN jsonb_build_array(
                   jsonb_build_object(
                       'id', 'converted-max-transfer-amount',
                       'kind', 'amount',
                       'max', plan.max_transfer_amount
                   )
               )
               ELSE '[]'::jsonb
           END,
    COALESCE(plan.active_default_action, 'allow'),
    NULL,
    sdp_iso_now(),
    sdp_iso_now()
FROM sdp_fold_wallet_plan plan;

-- Point existing profiles at their new revision and (re)activate them.
-- Brand-new profiles were already created active with active_revision_id
-- set above, so this only ever touches pre-existing rows.
UPDATE wallet_control_profiles wcp
SET
    active_revision_id = plan.new_revision_id,
    status = 'active',
    updated_at = sdp_iso_now(),
    activated_at = sdp_iso_now()
FROM sdp_fold_wallet_plan plan
WHERE wcp.id = plan.resolved_profile_id
  AND NOT plan.needs_new_profile;

DROP FUNCTION sdp_fold_wallet_policies_try_parse(TEXT);

DROP TABLE IF EXISTS payment_wallet_policies;
