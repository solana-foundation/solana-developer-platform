-- Asset Profiles: the SDP-owned description of what an issued token represents.
-- Exactly one active profile per issued token. A profile groups the token into
-- an Asset Category, identifies its Asset Type (+ version), stores the canonical
-- Issuance Metadata, and caches the safe public projection served by the token
-- metadata URI.
--
-- asset_category, asset_type and asset_type_version are intentionally left as
-- open TEXT/INTEGER (no CHECK constraint) so new product/regulatory families can
-- be added without a migration. Allowed values and category<->type consistency
-- are enforced at the application layer via the Asset Type Registry in
-- @sdp/types (ASSET_CATEGORIES / ASSET_TYPES). Initial categories: 'generic',
-- 'stablecoin', 'tokenized_security'.
--
-- issuance_metadata is the full, private master record. Shape:
--   { asset, compliance, chain, custom: { customer, integration } }
-- public_metadata is a CACHED projection of issuance_metadata, recomputed by the
-- application layer (registry projection rules) on every write. The public token
-- metadata URI endpoint returns public_metadata verbatim and never reads
-- issuance_metadata, so private compliance/custom fields cannot leak.

-- Composite unique on issued_tokens so asset_profiles can FK on
-- (token_id, organization_id, project_id) and guarantee a profile never points
-- at a token in a different org/project (mirrors the counterparties pattern).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM   pg_constraint
        WHERE  conname = 'issued_tokens_id_org_project_key'
    ) THEN
        ALTER TABLE issued_tokens ADD CONSTRAINT issued_tokens_id_org_project_key
            UNIQUE (id, organization_id, project_id);
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS asset_profiles (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    token_id TEXT NOT NULL,

    -- Asset Type Registry coordinates (validated in the application layer).
    asset_category TEXT NOT NULL DEFAULT 'generic',
    asset_type TEXT NOT NULL DEFAULT 'generic',
    asset_type_version INTEGER NOT NULL DEFAULT 1,

    -- Canonical, private master metadata record.
    issuance_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    -- Cached safe public subset, recomputed on every write from issuance_metadata.
    public_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    status TEXT NOT NULL DEFAULT 'active',
    created_by TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (token_id, organization_id, project_id)
        REFERENCES issued_tokens(id, organization_id, project_id)
        ON DELETE CASCADE,

    CONSTRAINT asset_profiles_issuance_metadata_is_object CHECK (jsonb_typeof(issuance_metadata) = 'object'),
    CONSTRAINT asset_profiles_public_metadata_is_object CHECK (jsonb_typeof(public_metadata) = 'object'),
    CONSTRAINT asset_profiles_status_check CHECK (status IN ('active', 'archived'))
);

-- One active profile per token ("an issued token has one Asset Profile").
-- Keyed by token_id alone: it is an FK to issued_tokens.id (a PRIMARY KEY), so
-- token_id is globally unique and a token can never appear under two org/project
-- scopes. Partial index lets an archived profile coexist with a
-- new active one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_asset_profiles_token_active
    ON asset_profiles(token_id)
    WHERE status = 'active';

-- Default list/filter query: by org+project, optionally narrowed by category.
CREATE INDEX IF NOT EXISTS idx_asset_profiles_org_project_category_created
    ON asset_profiles(organization_id, project_id, asset_category, created_at DESC)
    WHERE status = 'active';
