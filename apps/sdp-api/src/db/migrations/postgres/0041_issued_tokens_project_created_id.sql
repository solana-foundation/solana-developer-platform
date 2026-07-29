-- sdp:migration-mode: non-transactional
-- Default ordering for the asset list: newest-first with the id tiebreaker the
-- list query appends, so paging needs no separate sort step. Supersedes
-- idx_issued_tokens_project_created, which stops one column short of the
-- tiebreaker.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issued_tokens_project_created_id
    ON issued_tokens (project_id, created_at DESC, id DESC);
