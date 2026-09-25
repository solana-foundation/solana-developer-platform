-- Scan positions for the private-channel withdrawal release reconciler
-- (SOLA9-157).
--
-- The reconciler settles a `confirmed` withdrawal by walking the instance
-- escrow ATA's address history for the outgoing SPL release. A single fixed
-- newest-N page lets a permissionless payer evict a real release from every
-- scan by spamming newer transactions that merely reference the escrow ATA,
-- leaving the withdrawal stuck in `confirmed` with only a warning.
--
-- The reconciler pages backwards with `before` and persists two positions per
-- (instance, mint, escrow ATA), so progress survives across cron ticks and a
-- release cannot be pushed permanently out of reach:
--
--   cursor  — the parsed frontier: the newest signature whose history (itself
--             and everything older that is still relevant) has been fully
--             parsed and matched. It only ever moves toward newer slots (the
--             frontier advances as history is consumed) and never backward, so
--             an overlapping slower sweep cannot undo a faster one's progress.
--   sweep   — the deepest signature listed by a walk that hit the page cap
--             before reaching the cursor. A later tick resumes listing below
--             it, so even a backlog deeper than one tick's page cap is
--             eventually listed, parsed, and consumed by the cursor. NULL once
--             the cursor has consumed the listed backlog (or before the first
--             capped walk).
--
-- `vault_ata` is part of the key because an instance's escrow address can be
-- rotated; each escrow ATA keeps its own positions, and the reconciler only
-- ever reads the row for the CURRENT escrow ATA — a cursor derived from a
-- different escrow ATA is never consulted rather than skipping history on the
-- wrong address. A lagging poller that read the pre-rotation instance row
-- therefore cannot clobber the rotated escrow's progress (and vice versa).
--
-- Written and read only by the reconciler, a system workload. The chain
-- history it summarizes is public, so this discloses nothing.

CREATE TABLE IF NOT EXISTS private_channel_release_scans (
    instance_id TEXT NOT NULL REFERENCES private_channel_instances(id) ON DELETE CASCADE,
    mint TEXT NOT NULL,
    vault_ata TEXT NOT NULL,
    -- The parsed frontier: everything at or older than this signature has been
    -- fully parsed (and matched against a complete unsettled batch). NULL until
    -- the first complete walk.
    cursor_signature TEXT CHECK (cursor_signature IS NULL OR cursor_signature <> ''),
    -- The cursor's slot. The cursor never moves to an older slot; within a
    -- slot it advances only via the repository's compare-and-set on the
    -- stored cursor signature.
    cursor_slot TEXT CHECK (cursor_slot IS NULL OR cursor_slot ~ '^[0-9]+$'),
    -- The deepest signature listed by a page-cap-truncated walk, or NULL when
    -- no backlog is pending (no capped walk yet, or the cursor consumed it).
    sweep_signature TEXT CHECK (sweep_signature IS NULL OR sweep_signature <> ''),
    -- The sweep's slot. Sweeps only move deeper (to an older slot).
    sweep_slot TEXT CHECK (sweep_slot IS NULL OR sweep_slot ~ '^[0-9]+$'),
    CHECK ((cursor_signature IS NULL) = (cursor_slot IS NULL)),
    CHECK ((sweep_signature IS NULL) = (sweep_slot IS NULL)),
    updated_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    PRIMARY KEY (instance_id, mint, vault_ata)
);

ALTER TABLE private_channel_release_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_channel_release_scans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_private_channel_release_scans_system ON private_channel_release_scans;
CREATE POLICY sdp_private_channel_release_scans_system ON private_channel_release_scans
  USING (sdp_tenant_isolation_is_privileged())
  WITH CHECK (sdp_tenant_isolation_is_privileged());
