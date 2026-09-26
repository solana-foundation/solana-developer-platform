-- Solana Earn: the authenticated provider completion fact for provider orders.
--
-- Migration 0115 split irreversible chain finality from economic settlement
-- and left provider-order rows (WisdomTree) at `confirmed` with a
-- `chain_finalized_at` stamp: no authenticated provider-completion path
-- existed, so the settled surface could never truthfully close one and the
-- cross-key deposit-intent claim had to hold through finality forever. This
-- revision introduces that path's durable fact: when a provider-order
-- completion read (the provider's own API, reached with SDP's credentials)
-- correlates a deposit to its completed order, the reconciliation stamps the
-- moment here. The settlement boundary recognizes the stamp — and only this
-- stamp — so closing such a row for the `?settled=` surface releases its
-- cross-key claim with it, one completion fact moved once for both. Chain
-- finality alone (`chain_finalized_at`, row still `confirmed`) still never
-- does, and a legacy `settled_at` stamp remains the chain-era artifact it was
-- repaired to be in 0115, never a settlement fact.
--
-- The row's STATUS is deliberately untouched: `confirmed` stays the honest
-- chain state for a provider-order deposit, and the legacy deposit wire
-- already reads `confirmed` as terminal. The fact, not the status, is what
-- settles.
--
ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS provider_completed_at TEXT;

COMMENT ON COLUMN earn_movements.provider_completed_at IS
    'When an authenticated provider reconciler correlated this provider-order vault movement to the provider''s own completion record. Never a chain fact: Solana finality does not set it, and no other writer may. Releases the settled surface and the cross-key deposit-intent claim together.';

ALTER TABLE earn_movements
    DROP CONSTRAINT IF EXISTS earn_movements_provider_completion_shape;
ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_provider_completion_shape
    CHECK (
        provider_completed_at IS NULL
        OR (
            execution_model = 'vault_direct'
            AND status IN ('confirmed', 'finalized')
            AND NULLIF(BTRIM(provider_completed_at), '') IS NOT NULL
        )
    );

-- The completion pass re-reads exactly the rows the claim below selects, oldest
-- attempt first; a partial index keeps that scan as small as the set it serves.
CREATE INDEX IF NOT EXISTS idx_earn_movements_provider_completion_priority
    ON earn_movements (
        (COALESCE(reconciliation_attempted_at, created_at)) ASC,
        created_at ASC,
        id ASC
    )
    WHERE execution_model = 'vault_direct'
      AND direction = 'deposit'
      AND status = 'confirmed'
      AND chain_finalized_at IS NOT NULL
      AND provider_completed_at IS NULL;
