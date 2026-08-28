-- Helius Rings: one custom ring per project.
--
-- A custom ring is a pre-deployed on-chain program (ops deploys it; upgrade
-- authority is a project custody key). A project admin submits its program id,
-- SDP completes bring-up through the SDK (auditor key, ring config, shielded
-- pool registration) and records the outcome here. Operations name the ring
-- per call (ring: "custom") and are refused until this row is 'active';
-- default-ring operations never consult it.
--
--   status: 'pending' from submission, 'active' once bring-up confirmed on
--   chain, 'failed' with the failure recorded on the row. Bring-up is resumed
--   by re-submitting the same program id, so 'failed' is not terminal.
--
--   auditor_public_key: the ring config's P-256 auditor key as uncompressed
--   SEC1 hex, exactly as the chain publishes it. Public data — the secret half
--   lives with the Helius ring RPC, never in SDP.
--
-- Value-set CHECKs mirror RING_STATUSES in
-- packages/sdp-helius-rings/src/constants.ts, per the 0057 convention.
-- Timestamps are TEXT ISO-8601 via sdp_iso_now(), never NOW().

CREATE TABLE IF NOT EXISTS helius_rings_project_rings (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    ring_program_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    auditor_public_key TEXT,
    failure_code TEXT,
    failure_message TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    CONSTRAINT helius_rings_project_rings_status_check
        CHECK (status IN ('pending', 'active', 'failed')),
    -- 'active' is a claim the chain backs; recording it without the key the
    -- config publishes would leave nothing to verify the claim against.
    CONSTRAINT helius_rings_project_rings_active_has_auditor_check
        CHECK (status <> 'active' OR auditor_public_key IS NOT NULL),
    CONSTRAINT helius_rings_project_rings_id_org_project_key
        UNIQUE (id, organization_id, project_id),
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

-- Exactly one ring per project. Pointing wallets at two rings would split a
-- project's shielded balance across pools that cannot see each other, and the
-- gateway is constructed with one ring id per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_project_rings_project
    ON helius_rings_project_rings(project_id);
