-- 0119_payment_transfer_provenance_repair.sql
--
-- Repairs payment_transfers provenance on databases that already applied the
-- pre-fix 0005_project_environment_boundary.sql. The migration runner tracks
-- applied migrations by filename, so the corrected 0005 backfill only reaches
-- fresh databases; databases that ran the pre-fix file blanket-assigned every
-- NULL-project transfer to their org's default-sandbox project, surfacing
-- legacy production history under sandbox scope (APE-843).
--
-- api_keys.environment no longer exists here, but 0005 backfilled
-- api_keys.project_id from it before dropping the column, so the initiating
-- key's project_id is the durable record of the key's environment. Re-applies
-- the corrected 0005 semantics: resolve a legacy transfer's project from the
-- key that initiated it, and quarantine rows whose origin cannot be
-- established (no initiating key, a deleted key, or a key belonging to
-- another organization) as project_id NULL — invisible under every project
-- scope, org-visible for manual reconciliation — instead of leaving them in
-- the sandbox ledger.
--
-- Only rows currently assigned to their org's default-sandbox project are
-- touched, split by what provenance they carry:
--   - A row carrying an initiating-key reference is re-resolved through that
--     key (or quarantined when the key cannot establish its origin).
--   - A row without a key reference is quarantined only when it predates this
--     database's recorded 0005 application time (schema_migrations.applied_at):
--     it was NULL-project when the pre-fix blanket backfill ran, so it is
--     exactly the unattributed set the blanket moved into the sandbox ledger,
--     and quarantining restores the corrected 0005 semantics for it. A no-key
--     default-sandbox row created AFTER 0005 ran was scoped by the application
--     itself (for example a sandbox on-ramp created without an API key) and is
--     left in place — quarantining it would delete legitimate sandbox history
--     from project-scoped payment ledgers.
-- Rows already scoped to any other project were never NULL-project, so the
-- pre-fix 0005 never touched them and neither does this repair. On databases
-- that applied the corrected 0005 the statement is a no-op: key-carrying rows
-- at default-sandbox resolve back to it, quarantined rows are project_id NULL
-- (never matched), and no no-key row predates 0005 because a corrected
-- database quarantined those rows instead of assigning them to default-sandbox.
-- If the 0005 stamp is ever unreadable, the time comparison is NULL and only
-- key-carrying rows are touched — the repair degrades, it never fails.

UPDATE payment_transfers pt
SET    project_id = (
    SELECT ak.project_id
    FROM   api_keys ak
    WHERE  ak.id              = pt.initiated_by_key_id
      AND  ak.organization_id = pt.organization_id
      AND  ak.project_id      IS NOT NULL
    LIMIT  1
)
WHERE  pt.project_id = (
    SELECT p.id
    FROM   projects p
    WHERE  p.organization_id = pt.organization_id
      AND  p.slug            = 'default-sandbox'
)
  AND  (
        pt.initiated_by_key_id IS NOT NULL
        OR pt.created_at::timestamptz < (
            SELECT sm.applied_at::timestamptz
            FROM   schema_migrations sm
            WHERE  sm.version = '0005_project_environment_boundary.sql'
        )
      );
