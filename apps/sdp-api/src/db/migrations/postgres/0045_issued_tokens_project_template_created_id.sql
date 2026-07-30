-- sdp:migration-mode: non-transactional
-- Template-filtered asset list in default order, and the GROUP BY behind the
-- list's template facet counts.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issued_tokens_project_template_created_id
    ON issued_tokens (project_id, template, created_at DESC, id DESC);
