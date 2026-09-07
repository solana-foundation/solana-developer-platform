-- Helius Rings: a project's named custom rings.
--
-- A custom ring is a pre-deployed on-chain program (ops deploys it; upgrade
-- authority is a project custody key). A project admin submits a name and the
-- program id, SDP completes bring-up through the SDK (auditor key, ring
-- config, shielded pool registration, the ring's address lookup table) and
-- records the outcome here. Operations name a ring per call (ring: "<name>")
-- and are refused until that row is 'active'; default-ring operations never
-- consult this table.
--
--   name: the operator-chosen handle operations select the ring by. A slug,
--   because it appears in request bodies and logs; 'default' is reserved for
--   the default public pool and can never name a row.
--
--   status: 'pending' from submission, 'active' once bring-up confirmed on
--   chain, 'failed' with the failure recorded on the row. Bring-up is resumed
--   by re-submitting the same name and program id, so 'failed' is not terminal.
--
--   auditor_public_key: the ring config's P-256 auditor key as uncompressed
--   SEC1 hex, exactly as the chain publishes it. Public data — the secret half
--   lives with the Helius ring RPC, never in SDP.
--
--   lookup_table_address: the ring's one address lookup table; every ring
--   spend is a v0 transaction compressed through it. Created by bring-up with
--   custody as the table authority, and custody never signs another extend, so
--   its contents stay exactly ringLookupTableAddresses(ring, tree). Recorded
--   as soon as the table lands (before 'active') so a crashed bring-up resumes
--   by adopting the table instead of renting a second one.
--
-- Value-set CHECKs mirror RING_STATUSES and RING_NAME_PATTERN in
-- packages/sdp-helius-rings/src/constants.ts, per the 0057 convention.
-- Timestamps are TEXT ISO-8601 via sdp_iso_now(), never NOW().

CREATE TABLE IF NOT EXISTS helius_rings_project_rings (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    ring_program_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    auditor_public_key TEXT,
    lookup_table_address TEXT,
    failure_code TEXT,
    failure_message TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT helius_rings_project_rings_status_check
        CHECK (status IN ('pending', 'active', 'failed')),
    -- 'active' is a claim the chain backs: the auditor key to verify the claim
    -- against, and the lookup table every spend of the ring must ride through.
    CONSTRAINT helius_rings_project_rings_active_complete_check
        CHECK (
            status <> 'active'
            OR (auditor_public_key IS NOT NULL AND lookup_table_address IS NOT NULL)
        ),
    CONSTRAINT helius_rings_project_rings_name_format_check
        CHECK (
            name ~ '^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$'
            AND name <> 'default'
        ),
    CONSTRAINT helius_rings_project_rings_lookup_table_format_check
        CHECK (
            lookup_table_address IS NULL
            OR lookup_table_address ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        ),
    CONSTRAINT helius_rings_project_rings_id_org_project_key
        UNIQUE (id, organization_id, project_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Names address rings and program ids bind notes; both must be unambiguous
-- inside a project. A name resolving to two programs would pin the wrong ring
-- on an operation, and one program under two names would split a single
-- on-chain pool's audit trail across rows. Project-scoped, not global: two
-- projects adopting the same deployed program is a custody-authority question
-- bring-up already answers, not a schema one.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_project_rings_project_name
    ON helius_rings_project_rings(project_id, name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_project_rings_project_program
    ON helius_rings_project_rings(project_id, ring_program_id);
