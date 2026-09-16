-- Helius Rings: admit ring moves (ring_exit / ring_entry) into the operation
-- vocabulary.
--
-- A ring move crosses the boundary between a project's custom ring and the
-- default pool in a single transact: ring_exit spends ring-bound notes into
-- the wallet's own default-pool note, ring_entry the reverse. The custom
-- ring's program id is pinned in ring_program_id (0073) for both directions;
-- the op type carries which way the value crossed.

-- DROP + ADD rather than a conditional rewrite: the runner keys
-- schema_migrations on the file name, so this pair is idempotent under
-- re-runs and never leaves an older value list behind.
ALTER TABLE helius_rings_operations
    DROP CONSTRAINT IF EXISTS helius_rings_operations_op_type_check;

ALTER TABLE helius_rings_operations
    ADD CONSTRAINT helius_rings_operations_op_type_check
        CHECK (op_type IN (
            'shield',
            'transfer_registered',
            'transfer_anonymous',
            'withdraw',
            'merge',
            'timelock_create',
            'timelock_settle',
            'zone_create',
            'ring_exit',
            'ring_entry'
        ));

-- Ring moves consume notes, so they join the one-in-flight-spend-per-wallet
-- class. Recreated with the widened op_type list; the state clause is 0067's,
-- unchanged — see 0067 for why `failed AND signed` still holds the slot and
-- why the drop is unconditional.
DROP INDEX IF EXISTS idx_helius_rings_operations_active_spend;

CREATE UNIQUE INDEX idx_helius_rings_operations_active_spend
    ON helius_rings_operations(wallet_id)
    WHERE op_type IN ('transfer_registered', 'withdraw', 'merge', 'ring_exit', 'ring_entry')
      AND (
          state IN ('proving', 'ready_to_sign', 'submitted', 'indexing')
          OR (state = 'failed' AND signed_transaction IS NOT NULL)
      );
