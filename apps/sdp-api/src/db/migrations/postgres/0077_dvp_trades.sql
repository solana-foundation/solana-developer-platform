-- Atomic delivery-versus-payment trades settled by the on-chain DvP swap program
-- (PRO-1739). One row per on-chain SwapDvp.
--
-- Two things about this table are forced by the program rather than chosen.
--
-- 1. The six seed columns (settlement_authority, user_a, user_b, mint_a, mint_b,
--    nonce) are a CORRECTNESS requirement, not denormalisation. RecoverDvp
--    re-derives the PDA from exactly that tuple, and it is the only way to rescue
--    a deposit that lands after a trade closes. Lose them and a customer's late
--    transfer is unrecoverable (EXO-216/217).
--
-- 2. nonce and both amounts are TEXT because they are u64. Round-tripping them
--    through a JS number loses precision above 2^53, and the nonce is a PDA seed,
--    so a rounded value derives a different address entirely. expiry/earliest are
--    i64 seconds, stored the same way for the same reason.

CREATE TABLE IF NOT EXISTS dvp_trades (
    id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    project_id TEXT NOT NULL,

    -- Derived from the seed tuple below. Stored so a trade can be looked up by
    -- the address a counterparty sees, and to keep one row per on-chain trade.
    swap_dvp TEXT NOT NULL,

    -- The seed tuple. See note 1.
    settlement_authority TEXT NOT NULL,
    user_a TEXT NOT NULL,
    user_b TEXT NOT NULL,
    mint_a TEXT NOT NULL,
    mint_b TEXT NOT NULL,
    nonce TEXT NOT NULL,

    -- Per-leg token program. A single trade may legitimately mix legacy SPL and
    -- Token-2022, and ReclaimDvp needs the funded leg's program passed explicitly.
    token_program_a TEXT NOT NULL,
    token_program_b TEXT NOT NULL,

    -- Agreed economics. NOT bound by the PDA address, so these are exactly what a
    -- funder has to verify on chain before sending anything.
    amount_a TEXT NOT NULL,
    amount_b TEXT NOT NULL,
    expiry_timestamp TEXT NOT NULL,
    earliest_settlement_timestamp TEXT,
    user_a_settlement_destination TEXT NOT NULL,
    user_b_settlement_destination TEXT NOT NULL,

    -- Opaque client reference. Unauthenticated: anyone's forged create can carry
    -- ours, so never join on this alone without confirming program ownership, the
    -- 458-byte size, and PDA derivation.
    ref_string TEXT,

    -- Escrow ATAs the program creates. Derivable, stored because they are the
    -- addresses we publish to a counterparty and poll for funding.
    escrow_a TEXT NOT NULL,
    escrow_b TEXT NOT NULL,

    -- Which leg SDP holds, and the custody wallet behind it. The ordinary case is
    -- one side ours and one side an arbitrary external address.
    sdp_side TEXT NOT NULL CHECK (sdp_side IN ('a', 'b')),
    sdp_wallet_id TEXT NOT NULL,

    -- Last OBSERVED state. The program emits no events and funding never invokes
    -- it, so this is a cache of a poll, never authoritative on its own. A closed
    -- PDA is also indistinguishable across settle/cancel/reject without fetching
    -- the closing transaction, hence closed_unknown.
    --
    -- 'creating' is the DEFAULT because the row is written before the create
    -- transaction is broadcast. That ordering is not a style choice: the six seed
    -- columns above are the only durable copy of what RecoverDvp needs, and a
    -- crash between broadcast and insert would leave an on-chain trade nobody can
    -- recover. A retry cannot repair it either — it draws a fresh nonce and lands
    -- at a different address. So we record first and resolve afterwards, and
    -- 'creating' is the honest name for "signed, outcome not yet observed".
    status TEXT NOT NULL DEFAULT 'creating'
        CHECK (status IN (
            'creating',
            'create_failed',
            'created',
            'partially_funded',
            'funded',
            'settled',
            'cancelled',
            'rejected',
            'expired',
            'closed_unknown'
        )),
    observed_at TEXT,

    create_signature TEXT,
    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (sdp_wallet_id) REFERENCES custody_wallets(id) ON DELETE RESTRICT,

    -- One row per on-chain trade. The program's nonce tombstone already makes a
    -- (seeds, nonce) pair single-use forever, so this mirrors that guarantee.
    UNIQUE (swap_dvp)
);

CREATE INDEX IF NOT EXISTS dvp_trades_project_status_idx
    ON dvp_trades(project_id, status);

-- Funding detection sweeps trades that are still open. 'creating' is in the set
-- because those rows are exactly the ones whose broadcast outcome is unknown and
-- has to be resolved by looking at the chain.
CREATE INDEX IF NOT EXISTS dvp_trades_open_idx
    ON dvp_trades(project_id, updated_at)
    WHERE status IN ('creating', 'created', 'partially_funded');
