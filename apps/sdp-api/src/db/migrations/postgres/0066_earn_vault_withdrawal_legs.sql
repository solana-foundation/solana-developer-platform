-- Solana Earn: vault-direct withdrawals land in the unified ledger as
-- PER-TRANSACTION LEG ROWS (PRO-1702).
--
-- ── Why legs are movement rows and not a sub-table ─────────────────────────
-- A K-Vault exit may genuinely need several transactions — one withdraw
-- instruction per reserve the vault draws from, each carrying the vault's full
-- reserve account list — and each transaction is a real on-chain money movement
-- with its own signature, its own signed bytes, its own blockhash window and
-- its own fate. That is exactly the shape `earn_movements` already reconciles:
-- the sweep polls BY SIGNATURE and rebroadcasts recorded bytes, so a leg that
-- is an ordinary vault movement row plugs into record-before-broadcast,
-- rebroadcast and finalization with no second machinery. A child table would
-- have re-created the mechanism-split PRO-1705 just removed.
--
-- Three columns tie a withdrawal's legs together:
--   leg_group_id  one exit request = one group (minted with the intent)
--   leg_index     0-based submission order within the group
--   leg_count     total legs the plan carried, stamped on every row so a
--                 partial read still knows what "complete" means
--
-- Ordering is LOAD-BEARING, not descriptive: leg N+1's instructions may depend
-- on leg N having landed (an unstake frees the shares later withdraws burn),
-- so the submitter and the reconciliation sweep broadcast a leg only after its
-- predecessor reached optimistic commitment, and fail a leg whose predecessor
-- failed. A single-transaction withdrawal is simply a group of one — uniform,
-- so no reader special-cases the common case.
--
-- ── The denomination decision (ADR 0002 addendum, PRO-1702) ────────────────
-- A vault WITHDRAWAL row is denominated in the SHARE MINT and
-- `amount_requested` is the exact share quantity that leg's instructions
-- encode (`sharesAmount: u64`, decoded from the instruction bytes — never an
-- estimate). Deposits stay denominated in the deposit-token mint. The tokens a
-- withdrawal returns are decided by the chain at execution and are therefore
-- NOT a fact the intent can record; writing a build-time token estimate into a
-- money column would launder an estimate into "what moved" the moment
-- settlement copies it. Shares are what the caller asked to move, what the
-- transaction encodes, and what lands — exact at intent, exact at settlement.
-- `denomination` was always an open set for precisely this reason, and no read
-- may sum amounts without grouping by it, so share-denominated rows can never
-- blend into token sums.
--
-- request_id keeps 0059's meaning on leg 0 — the caller's raw Idempotency-Key,
-- the replay anchor under the (organization_id, request_id) partial unique.
-- Later legs derive theirs as `<key> || E'\n' || 'leg:' || index`: a newline
-- can never appear in a legal Idempotency-Key ([\x20-\x7e], see
-- middleware/idempotency-key.ts), so a derived id can never collide with any
-- caller's real key.
--
-- No backfill: the vault withdraw path ships with this migration, so no
-- existing row is a vault withdrawal and the constraint validates instantly.

ALTER TABLE earn_movements ADD COLUMN IF NOT EXISTS leg_group_id TEXT;
ALTER TABLE earn_movements ADD COLUMN IF NOT EXISTS leg_index INTEGER;
ALTER TABLE earn_movements ADD COLUMN IF NOT EXISTS leg_count INTEGER;

-- Exactly one shape: every vault withdrawal carries a complete, coherent leg
-- identity, and nothing else may carry any of it. The first arm covers every
-- pre-existing row (deposits, custodial movements), so adding this constraint
-- needs no backfill and validates on creation.
ALTER TABLE earn_movements
    ADD CONSTRAINT earn_movements_leg_shape_check
    CHECK (
        (
            leg_group_id IS NULL
            AND leg_index IS NULL
            AND leg_count IS NULL
            AND NOT (execution_model = 'vault_direct' AND direction = 'withdrawal')
        )
        OR (
            execution_model = 'vault_direct'
            AND direction = 'withdrawal'
            AND leg_group_id IS NOT NULL
            AND leg_index IS NOT NULL
            AND leg_count IS NOT NULL
            AND leg_count >= 1
            AND leg_index >= 0
            AND leg_index < leg_count
        )
    );

-- One row per (group, index): the submitter and the sweep resolve "the
-- predecessor leg" through this, so a duplicate leg would make ordering
-- ambiguous exactly where it decides whether money moves. Also the group
-- listing's index (organization_id is asserted after the fetch, like the
-- provider-reference lookup).
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_movements_leg_group
    ON earn_movements(leg_group_id, leg_index)
    WHERE leg_group_id IS NOT NULL;
