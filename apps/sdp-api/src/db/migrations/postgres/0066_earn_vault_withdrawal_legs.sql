-- Solana Earn: one business movement per vault withdrawal, with ordered signed
-- transactions in an internal child outbox (PRO-1702).
--
-- `earn_movements` remains the user-facing financial ledger. A withdrawal row
-- records the caller's total requested shares and owns the idempotency key,
-- actor, holding and aggregate lifecycle. `earn_vault_withdrawal_legs` records
-- only execution detail: exact literal shares, signed bytes, signature,
-- blockhash window and per-transaction status. This avoids representing one
-- user action as several unrelated financial movements while retaining the
-- record-before-broadcast and ordered-recovery guarantees.

-- 0062 required every vault movement itself to carry signed bytes. Deposits
-- still do. Withdrawal bytes now live in the child outbox, so the parent is
-- deliberately unsigned.
ALTER TABLE earn_movements
    DROP CONSTRAINT earn_movements_model_shape_check;

ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_model_shape_check
    CHECK (
        (
            execution_model = 'vault_direct'
            AND direction = 'deposit'
            AND custody_wallet_id IS NOT NULL
            AND vault_address IS NOT NULL
            AND signature IS NOT NULL
            AND signed_transaction IS NOT NULL
            AND last_valid_block_height IS NOT NULL
            AND payout_token IS NULL
            AND fee_amount IS NULL
        )
        OR (
            execution_model = 'vault_direct'
            AND direction = 'withdrawal'
            AND custody_wallet_id IS NOT NULL
            AND vault_address IS NOT NULL
            AND signature IS NULL
            AND signed_transaction IS NULL
            AND last_valid_block_height IS NULL
            AND payout_token IS NULL
            AND fee_amount IS NULL
            AND min_shares_out IS NULL
        )
        OR (
            execution_model = 'custodial'
            AND custody_wallet_id IS NULL
            AND vault_address IS NULL
            AND signature IS NULL
            AND signed_transaction IS NULL
            AND last_valid_block_height IS NULL
            AND min_shares_out IS NULL
            AND shares_out IS NULL
        )
    );

CREATE TABLE earn_vault_withdrawal_legs (
    movement_id TEXT NOT NULL,
    leg_index INTEGER NOT NULL,
    shares TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'requested',
    signature TEXT NOT NULL,
    signed_transaction TEXT NOT NULL,
    last_valid_block_height NUMERIC NOT NULL,
    failure_reason TEXT,
    confirmed_at TEXT,
    settled_at TEXT,
    reconciliation_attempted_at TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    PRIMARY KEY (movement_id, leg_index),
    UNIQUE (signature),
    FOREIGN KEY (movement_id) REFERENCES earn_movements(id) ON DELETE CASCADE,

    CONSTRAINT earn_vault_withdrawal_legs_index_check
        CHECK (leg_index >= 0),
    CONSTRAINT earn_vault_withdrawal_legs_status_check
        CHECK (status IN ('requested', 'submitted', 'confirmed', 'finalized', 'failed')),
    CONSTRAINT earn_vault_withdrawal_legs_shares_check
        CHECK (
            LENGTH(shares) BETWEEN 1 AND 128
            AND shares ~ '^\d+(\.\d+)?$'
            AND shares ~ '[1-9]'
        ),
    CONSTRAINT earn_vault_withdrawal_legs_block_height_check
        CHECK (
            last_valid_block_height = TRUNC(last_valid_block_height)
            AND last_valid_block_height BETWEEN 0 AND 18446744073709551615
        ),
    CONSTRAINT earn_vault_withdrawal_legs_confirmation_check
        CHECK (
            (status IN ('confirmed', 'finalized'))
            = (NULLIF(BTRIM(confirmed_at), '') IS NOT NULL)
        ),
    CONSTRAINT earn_vault_withdrawal_legs_settlement_check
        CHECK ((status = 'finalized') = (NULLIF(BTRIM(settled_at), '') IS NOT NULL)),
    CONSTRAINT earn_vault_withdrawal_legs_failure_check
        CHECK ((status = 'failed') = (NULLIF(BTRIM(failure_reason), '') IS NOT NULL))
);

CREATE INDEX idx_earn_vault_withdrawal_legs_unsettled
    ON earn_vault_withdrawal_legs(
        COALESCE(reconciliation_attempted_at, created_at),
        created_at,
        movement_id,
        leg_index
    )
    WHERE status IN ('requested', 'submitted', 'confirmed');
