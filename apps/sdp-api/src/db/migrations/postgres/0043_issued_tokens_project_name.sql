-- sdp:migration-mode: non-transactional
-- Backs the A–Z / Z–A asset sort. LOWER(name) matches the list query's
-- case-insensitive ordering; the trailing id is its tiebreaker, and a backward
-- scan serves the descending direction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issued_tokens_project_name
    ON issued_tokens (project_id, LOWER(name), id);
