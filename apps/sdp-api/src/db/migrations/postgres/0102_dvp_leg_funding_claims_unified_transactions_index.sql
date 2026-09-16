-- sdp:migration-mode: non-transactional
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dvp_leg_funding_claims_organization_created_trade ON dvp_leg_funding_claims(organization_id, created_at DESC, trade_id DESC, side DESC);
