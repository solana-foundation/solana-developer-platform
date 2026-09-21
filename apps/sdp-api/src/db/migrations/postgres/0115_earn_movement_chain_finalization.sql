-- Solana Earn: separate irreversible chain finality from economic settlement.
--
-- For an atomic vault movement those facts coincide, so `settled_at` and the
-- terminal `finalized` status are honest. A provider-order movement is
-- different: Solana finality proves only that the payment/share leg cannot be
-- rolled back; the provider still has to complete the subscription/redemption.
-- Persist that narrower fact so reconciliation keeps polling through ordinary
-- confirmation, then removes the row from its hot queue only after finality.
--
ALTER TABLE earn_movements
    ADD COLUMN IF NOT EXISTS chain_finalized_at TEXT;

COMMENT ON COLUMN earn_movements.chain_finalized_at IS
    'When SDP observed irreversible Solana finality for a provider-order vault leg. This is not provider settlement and never implies settled_at or token_amount_settled.';

-- Repair the short-lived pre-0115 representation. That revision wrote a known
-- WisdomTree provider-order leg as finalized/settled as soon as Solana reached
-- finality, even though no authenticated provider-completion path existed. For
-- these rows the old settled_at is unambiguously the chain-finality observation,
-- so preserve it in the narrower column and restore the honest pending state.
-- Reopen the holding as well: position hydration may have hidden a zero-share
-- holding while the subscription shares or redemption payout were still due.
--
-- Existing merely-confirmed rows are intentionally not backfilled: they may
-- have reached either confirmed or finalized commitment, and must be re-polled
-- to distinguish those states.
WITH repaired AS (
    UPDATE earn_movements
       SET status = 'confirmed',
           chain_finalized_at = COALESCE(
               NULLIF(BTRIM(settled_at), ''),
               NULLIF(BTRIM(confirmed_at), ''),
               sdp_iso_now()
           ),
           settled_at = NULL,
           token_amount_settled = NULL,
           updated_at = sdp_iso_now()
     WHERE execution_model = 'vault_direct'
       AND provider = 'wisdomtree'
       AND status = 'finalized'
     RETURNING position_id, organization_id
)
UPDATE earn_positions position
   SET closed_at = NULL,
       updated_at = sdp_iso_now()
  FROM repaired
 WHERE position.id = repaired.position_id
   AND position.organization_id = repaired.organization_id;

ALTER TABLE earn_movements
    DROP CONSTRAINT IF EXISTS earn_movements_chain_finalization_shape;
ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_chain_finalization_shape
    CHECK (
        chain_finalized_at IS NULL
        OR (
            execution_model = 'vault_direct'
            AND status IN ('confirmed', 'finalized')
            AND NULLIF(BTRIM(confirmed_at), '') IS NOT NULL
            AND NULLIF(BTRIM(chain_finalized_at), '') IS NOT NULL
        )
    );

-- Keep provider-order rows with durable finality evidence out of the new
-- worker's hot index as well as its query. Retain 0065's broader index for
-- application revisions that do not yet know this column exists; a later
-- contract migration can remove it.
CREATE INDEX IF NOT EXISTS idx_earn_movements_unfinalized_reconciliation_priority
    ON earn_movements (
        (status = 'confirmed'),
        (COALESCE(reconciliation_attempted_at, created_at)) ASC,
        created_at ASC,
        id ASC
    )
    WHERE execution_model = 'vault_direct'
      AND status IN ('requested', 'submitted', 'confirmed')
      AND chain_finalized_at IS NULL;
