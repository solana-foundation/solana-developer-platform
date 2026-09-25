-- Solana Earn: the provider-order completion stamp carries the ORDER's identity.
--
-- Migration 0120 introduced the durable completion fact (`provider_completed_at`)
-- that closes a provider-order row and releases its cross-key deposit-intent
-- claim. Its correlation, however, identified "the deposit's order" by wallet,
-- fund, amount, and a completion-instant bound — never by the order's own
-- identity — so two deposits of the same shape could both be closed by the SAME
-- completed order: the first deposit's order would demonstrate the second
-- deposit's settlement while its own order is still pending. The claim released
-- early, and a twin could double-broadcast for money already committed.
--
-- This revision binds the stamp to the order that justifies it and makes one
-- order's completion consumable exactly once, per provider, by the database:
--
-- - `provider_completed_order_reference` records the provider's own identity
--   for the completed order alongside the moment. The completion reader
--   refuses any candidate order without a readable identity (an order that
--   cannot name itself cannot be shown to belong to THIS deposit rather than
--   an older twin's), and skips identities the ledger has already accepted —
--   so a twin deposit waits for its OWN order instead of inheriting another
--   deposit's completion.
-- - The unique partial index turns "one order settles one movement" from a
--   reading of the correlation into a constraint: a second stamp naming an
--   order that already completed another movement does not apply.
-- - The shape constraint requires the identity wherever it requires the fact.
--
-- Rows the pre-identity reconciler already stamped keep their fact — it was
-- demonstrated, just not bound — and carry a synthetic per-row reference so
-- the tightened constraint accepts them without pretending an identity was
-- ever read.
--
ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS provider_completed_order_reference TEXT;

UPDATE earn_movements
    SET provider_completed_order_reference = 'unbound-' || id
  WHERE provider_completed_at IS NOT NULL
    AND NULLIF(BTRIM(provider_completed_order_reference), '') IS NULL;

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
            AND NULLIF(BTRIM(provider_completed_order_reference), '') IS NOT NULL
        )
    );

CREATE UNIQUE INDEX IF NOT EXISTS earn_movements_provider_completion_order_unique
    ON earn_movements (provider, provider_completed_order_reference)
    WHERE provider_completed_order_reference IS NOT NULL;

COMMENT ON COLUMN earn_movements.provider_completed_order_reference IS
    'The provider''s own identity for the order whose completion stamped provider_completed_at. The fact and the identity that justifies it move together: the completion read refuses candidates that cannot name themselves and skips identities the ledger already accepted, and the unique index makes one order''s completion settle at most one movement per provider.';
