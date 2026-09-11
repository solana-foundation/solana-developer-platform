-- sdp:migration-mode: non-transactional
--
-- Solana Earn: SDP-wide vault exposure aggregate (ADR 0004 layer 1, PRO-1934).
--
-- Every vault deposit admission now sums money INTO the target vault across
-- every organization on the environment (`sumVaultDepositExposure`,
-- earn-movements.repository.ts). The existing earn_movements indexes are all
-- organization-led, so a platform-wide aggregate keyed on the vault would scan
-- the heap. One partial index on the deposit slice serves it: the predicate is
-- equality on (environment, provider, vault_address) plus the status set, and
-- the SUM reads the two amount columns.
--
-- Partial on vault deposits so the custodial rows and the exits stay out of
-- it; the aggregate never subtracts withdrawals (they are ledgered in shares).
--
-- CONCURRENTLY for the same reason as 0073: earn_movements is the append-heavy
-- table in this domain, and the migration adds nothing but the index.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_earn_movements_vault_exposure
    ON earn_movements(
        environment,
        provider,
        vault_address,
        status
    )
    INCLUDE (amount_settled, amount_requested)
    WHERE execution_model = 'vault_direct'
      AND direction = 'deposit'
      AND vault_address IS NOT NULL;
