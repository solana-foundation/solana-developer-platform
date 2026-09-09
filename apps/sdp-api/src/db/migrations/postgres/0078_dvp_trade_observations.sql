-- What the funding reconciler last observed on chain for a DvP trade (PRO-1840).
--
-- Funding is invisible to the program. A party funds a leg with a plain
-- TransferChecked to the escrow ATA; the DvP program is never invoked and emits
-- no event, so the only way to know a leg is funded is to read the escrow
-- balance. These columns are that reading — an observation with a timestamp,
-- never an authority. `dvp_trades.observed_at` says when they were taken.
--
-- Three facts, not one, because they drive different answers:
--
-- 1. The balance, as TEXT. It is a u64 like the amounts it is compared against,
--    and a JS number rounds above 2^53.
--
-- 2. Whether the balance EXCEEDS the target. Settle requires `balance >= amount`
--    and refunds the surplus to the depositor, but that refund is a second
--    transfer: on a transfer-hook mint whose ExtraAccountMetaList resolves
--    accounts from the destination or amount, it can revert the whole
--    settlement (program/src/processor/settle_dvp.rs:270+). So a surplus is a
--    settlement risk to surface, not a harmless overpayment — and it is easy to
--    cause, because anyone can transfer into the escrow.
--
-- 3. Whether the escrow is FROZEN. An escrow on a mint with
--    DefaultAccountState(frozen) is born frozen, and funding transfers into it
--    bounce. That is indistinguishable from "nobody has paid yet" by balance
--    alone, and it is the difference between waiting and being blocked.

ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS escrow_a_amount TEXT,
    ADD COLUMN IF NOT EXISTS escrow_b_amount TEXT,
    ADD COLUMN IF NOT EXISTS escrow_a_frozen BOOLEAN,
    ADD COLUMN IF NOT EXISTS escrow_b_frozen BOOLEAN;

-- The block height past which the create transaction can no longer be accepted.
--
-- This is the ONLY sound way to call a `creating` trade dead. A create is signed
-- against a blockhash with a bounded validity window; once the cluster passes
-- that height the transaction can never land, and before it the transaction may
-- still be in flight. Anything else — elapsed wall-clock time, a retry count —
-- is a guess about the network dressed up as a fact about the trade, and
-- guessing wrong in the optimistic direction tells an operator no escrow exists
-- while its address sits on chain waiting to be funded.
--
-- TEXT because it is a u64 like everything else that crosses this boundary.
ALTER TABLE dvp_trades
    ADD COLUMN IF NOT EXISTS create_last_valid_block_height TEXT;

-- The sweep orders by how stale an observation is, so it revisits the trade it
-- knows least about first. NULLS FIRST puts never-observed trades at the front.
CREATE INDEX IF NOT EXISTS dvp_trades_stale_observation_idx
    ON dvp_trades(observed_at NULLS FIRST)
    WHERE status IN ('creating', 'created', 'partially_funded', 'funded');
