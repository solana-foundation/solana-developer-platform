-- sdp:migration-mode: non-transactional
--
-- Every guarded custody wallet deactivation counts the open DvP trades that
-- name the wallet as settlement authority (APE-878). Without an index on
-- settlement_authority that count scans every trade, even for a wallet DvP
-- never used. The predicate is LOAD_BEARING_DVP_TRADE_STATUSES_SQL in
-- custody-config.store.ts; keep the two in step.
--
-- CONCURRENTLY avoids blocking trade writes while the index builds.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dvp_trades_open_settlement_authority
    ON dvp_trades(settlement_authority)
    WHERE status IN ('creating', 'created', 'partially_funded', 'funded', 'expired');
