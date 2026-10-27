-- sdp:migration-mode: non-transactional
-- A tenant key on batch recipients, as payment_transfers and
-- payment_transfer_batches have one (0021), so a token movement leg (0185)
-- can name its recipient together with the recipient's organization and
-- project, and never a recipient of another tenant. `id` is already the
-- primary key, so the index cannot reject a row; it is built CONCURRENTLY
-- because recipients are written while the migration runs.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS payment_transfer_recipients_id_org_project_key
  ON payment_transfer_recipients (id, organization_id, project_id);
