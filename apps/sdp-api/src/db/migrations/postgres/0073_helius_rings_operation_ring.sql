-- Helius Rings: pin each operation to the ring it targets.
--
-- Ring selection is per operation: a shield names the default ring or the
-- project's custom ring, the service resolves that selector at prepare time
-- and persists the resolved program id here. Approvals can land days after
-- prepare, and the project's ring row is never re-read: the pipeline builds
-- against this column, so the ring the approver saw is the ring that runs.
-- NULL means the default public ring.
--
-- No FK to helius_rings_project_rings: a never-active ring row can be
-- re-pointed under a failed operation, and an operation is history -- it
-- outlives edits to the ring row. The only writer is the service, which
-- copies the id from the project's ring row (or writes NULL).

-- No backfill: no environment has ever run a custom-ring operation (the
-- lockout-era code shipped nowhere that used it), so every existing row is a
-- default-ring operation and NULL already says so.
ALTER TABLE helius_rings_operations
    ADD COLUMN IF NOT EXISTS ring_program_id TEXT;

ALTER TABLE helius_rings_operations
    DROP CONSTRAINT IF EXISTS helius_rings_operations_ring_program_id_format_check;

-- Same "make garbage unrepresentable" convention as 0057's format CHECKs;
-- mirrors createProjectRingSchema's base58 shape.
ALTER TABLE helius_rings_operations
    ADD CONSTRAINT helius_rings_operations_ring_program_id_format_check
        CHECK (
            ring_program_id IS NULL
            OR ring_program_id ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
        );
