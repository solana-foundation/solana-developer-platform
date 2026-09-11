-- Solana Earn: corroborate before expiring a SUBMITTED vault movement whose
-- signature the RPC does not know (PRO-1904, threat model EARN-006).
--
-- ── The asymmetry this closes ──────────────────────────────────────────────
-- The reconciliation sweep treats a null `getSignatureStatuses` answer two
-- ways. A `confirmed` row is left alone: the transaction demonstrably landed
-- and RPC history simply forgot it. A `submitted` row was expired to `failed`
-- the moment the chain height passed its `last_valid_block_height`, on ONE
-- null observation, with no corroboration. RPC history is not complete (that
-- is exactly why the `confirmed` guard exists), so a submitted movement that
-- landed and aged out of history before the sweep ever saw it `confirmed`
-- became a false `failed`: the ledger said the money did not move while the
-- shares sat in the vault, and `failed` is terminal, so nothing repaired it.
--
-- ── The evidence bar ───────────────────────────────────────────────────────
-- Expiry of a `submitted` row now takes TWO null observations on separate
-- sweep ticks, both past the blockhash window. This column is the first one.
-- It is written only by the sweep (the interactive detail read never expires),
-- only on a `submitted` row, and only once (COALESCE), so a burst of ticks
-- cannot stack observations. A later tick that finds the signature moves the
-- row forward and the column becomes inert history. `requested` rows keep the
-- one-tick rule: an unbroadcast transaction past its blockhash cannot land.
--
-- A dedicated column rather than `provider_data`: that JSONB is the
-- provider's payload, and a sweep bookkeeping mark hidden in it would be
-- invisible to the constraint below and to anyone reading the row.

ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS unknown_signature_observed_at TEXT;

COMMENT ON COLUMN earn_movements.unknown_signature_observed_at IS
    'When the reconciliation sweep first saw this SUBMITTED movement''s signature unknown to RPC after its blockhash window closed. A second such observation on a later tick expires the row; NULL means never observed. Never written for requested or confirmed rows.';

-- Only a broadcast movement can be observed unknown: a `requested` row has not
-- been sent, and `confirmed` rows are never expired. Terminal rows keep the
-- mark as history of how they got there.
ALTER TABLE earn_movements
    DROP CONSTRAINT IF EXISTS earn_movements_unknown_signature_observation_shape;
ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_unknown_signature_observation_shape
    CHECK (unknown_signature_observed_at IS NULL OR status <> 'requested');
