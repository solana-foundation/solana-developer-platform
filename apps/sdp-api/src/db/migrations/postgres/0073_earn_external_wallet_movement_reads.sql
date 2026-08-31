-- sdp:migration-mode: non-transactional
--
-- Solana Earn: read path for external-wallet movements (PRO-1772).
--
-- 0070 made external-wallet rows structurally invisible to every custody-scoped
-- read, which was correct for treasury surfaces and left the B2B2C surface
-- write-only: a partner could submit a movement and never list it again, and
-- the cross-provider feed's vault arm requires a custody-wallet match that an
-- owner-signed row can never satisfy. PRO-1772 adds per-owner reads (activity,
-- movement detail, earnings), all scoped (org, project, environment, owner) —
-- the same key as the 0070 position claim, because the external wallet belongs
-- to the partner org AND project.
--
-- One index serves the new reads: the activity list pages (created_at, id)
-- keysets newest-first for one owner, and the earnings aggregate groups the
-- same owner-bounded slice by position. Partial on owner_address so the
-- treasury movement indexes stay untouched, mirroring
-- idx_earn_positions_external_wallet_owner.
--
-- CONCURRENTLY because earn_movements is the append-heavy table in this
-- domain: a plain build takes a lock that blocks the money writers for the
-- build's duration, and this migration adds nothing but the index, which is
-- exactly the shape the non-transactional runner mode exists for (it also
-- drops-and-retries an INVALID leftover from an interrupted build).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_movements_external_wallet_owner
    ON earn_movements(
        organization_id,
        project_id,
        environment,
        owner_address,
        created_at DESC,
        id DESC
    )
    WHERE owner_address IS NOT NULL;
