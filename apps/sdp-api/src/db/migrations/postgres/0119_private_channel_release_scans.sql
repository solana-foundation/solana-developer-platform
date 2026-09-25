-- Scan cursor for the private-channel withdrawal release reconciler
-- (SOLA9-157).
--
-- The reconciler settles a `confirmed` withdrawal by walking the instance
-- escrow ATA's address history for the outgoing SPL release. A single fixed
-- newest-N page lets a permissionless payer evict a real release from every
-- scan by spamming newer transactions that merely reference the escrow ATA,
-- leaving the withdrawal stuck in `confirmed` with only a warning.
--
-- The reconciler now pages backwards with `before` and persists how far each
-- (instance, mint) scan has walked, so progress survives across cron ticks and
-- a release cannot be pushed permanently out of reach: the cursor only ever
-- moves deeper (to an older slot) over signatures that were fully parsed.
--
-- `vault_ata` is stored beside the cursor because an instance's escrow address
-- can be rotated; a cursor derived from a different escrow ATA is discarded and
-- the scan starts fresh rather than skipping history on the wrong address.
--
-- Written and read only by the reconciler, a system workload. The chain
-- history it summarizes is public, so this discloses nothing.

CREATE TABLE IF NOT EXISTS private_channel_release_scans (
    instance_id TEXT NOT NULL REFERENCES private_channel_instances(id) ON DELETE CASCADE,
    mint TEXT NOT NULL,
    vault_ata TEXT NOT NULL,
    -- The deepest signature whose history (itself and everything older that is
    -- still relevant) the reconciler has fully parsed for this escrow ATA.
    cursor_signature TEXT NOT NULL,
    -- The cursor's slot. Overlapping sweeps never move the cursor back behind
    -- a slot the other already passed; equal slots keep the stored row.
    cursor_slot TEXT NOT NULL CHECK (cursor_slot ~ '^[0-9]+$'),
    updated_at TEXT NOT NULL DEFAULT (sdp_iso_now()),
    PRIMARY KEY (instance_id, mint)
);

ALTER TABLE private_channel_release_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE private_channel_release_scans FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sdp_private_channel_release_scans_system ON private_channel_release_scans;
CREATE POLICY sdp_private_channel_release_scans_system ON private_channel_release_scans
  USING (sdp_tenant_isolation_is_privileged())
  WITH CHECK (sdp_tenant_isolation_is_privileged());
