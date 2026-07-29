-- sdp:migration-mode: non-transactional
-- Keeps contains-style asset search (name, symbol, mint address, id) indexed as
-- a project's asset count grows. The expression must stay in lockstep with
-- TOKEN_SEARCH_EXPRESSION in token.service.ts — a mismatch silently downgrades
-- every search to a sequential scan.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_issued_tokens_search_trgm
    ON issued_tokens USING GIN ((
        name || ' ' ||
        symbol || ' ' ||
        COALESCE(mint_address, '') || ' ' ||
        id
    ) gin_trgm_ops);
