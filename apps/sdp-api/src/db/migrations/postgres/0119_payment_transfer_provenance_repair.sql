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
-- established (no initiating key, deleted key, or a key belonging to another
-- organization) as project_id NULL — invisible under every project scope,
-- org-visible for manual reconciliation — instead of leaving them in the
-- sandbox ledger.
--
-- Only rows currently assigned to their org's default-sandbox project are
-- touched: that is exactly the set the pre-fix blanket backfill created. Rows
-- already scoped to any other project were never NULL-project, so the pre-fix
-- 0005 never touched them and neither does this repair. On databases that
-- applied the corrected 0005 this statement is a no-op: rows at
-- default-sandbox initiated by sandbox keys resolve back to default-sandbox,
-- and quarantined rows are project_id NULL, which this WHERE clause never
-- matches.

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
);
