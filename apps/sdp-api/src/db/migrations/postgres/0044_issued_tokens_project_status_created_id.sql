-- sdp:migration-mode: non-transactional
-- Status-filtered asset list in default order. Extends
-- idx_issued_tokens_project_status_created with the id tiebreaker so a filtered
-- page is served without a sort step.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issued_tokens_project_status_created_id
    ON issued_tokens (project_id, status, created_at DESC, id DESC);
