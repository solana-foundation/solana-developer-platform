-- sdp:migration-mode: non-transactional
--
-- Embedded Yield reads every external-wallet claim for one project in
-- newest-first keyset order. The existing external-wallet index is owner-first,
-- which is ideal for one customer's portfolio but forces the project-wide
-- summary to sort after scanning every owner. Keep both access paths explicit.
--
-- CONCURRENTLY avoids blocking deposits while Postgres builds the index over
-- the live claim table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_positions_external_wallet_project_created
    ON earn_positions(
        organization_id,
        project_id,
        environment,
        created_at DESC,
        id DESC
    )
    WHERE kind = 'vault_direct'
      AND owner_address IS NOT NULL
      AND activated_at IS NOT NULL;
