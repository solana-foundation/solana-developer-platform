-- Which custody wallet signed a trade's close (APE-695 review follow-up).
--
-- A close is authorized by the settlement wallet the close flow resolves: the
-- project's mapped settlement wallet (0079), required to match the trade's
-- authority before anything is signed. Its PUBLIC KEY is already on the row as
-- `settlement_authority` — but the key is not the wallet. Several custody
-- wallets can hold one key (a provisioning race leaves the loser behind), and
-- the mapping the close flow resolved can rotate to a different key later, so
-- re-resolving the key through today's wallets and today's mapping cannot
-- always tell which wallet signed. When it cannot, the unified feed may name
-- the orphan, and a read scoped to the wallet that actually signed misses the
-- closes it signed.
--
-- So the signing wallet's record id is written here when WE record the close —
-- `recordClose`, from the wallet the handler authorized. The unified
-- transaction feed attributes a close row to this wallet first, and only falls
-- back to resolving `settlement_authority` for closes it cannot name this way:
-- ones observed from the chain, and every close recorded before this column
-- existed. Written once with the close, never updated: which wallet signed a
-- landed close does not change.
--
-- RESTRICT, like every column that is evidence about something on chain
-- (0090, 0119): deleting the wallet must not erase what it signed. The wallet
-- belongs to the trade's own project — the close flow resolves it through the
-- trade's tenant — so ordinary row-level security is the only read this column
-- needs; no new policy.

ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS close_custody_wallet_id TEXT
    REFERENCES custody_wallets(id) ON DELETE RESTRICT;

COMMENT ON COLUMN dvp_trades.close_custody_wallet_id IS
  'The custody wallet that signed the close, recorded by the close flow. NULL for closes observed from the chain and for closes recorded before this column existed; the unified feed resolves those through settlement_authority.';
