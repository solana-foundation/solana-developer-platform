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

-- Closes the audit ledger can already name, copied onto the trade at deploy.
--
-- Everything recorded before this column existed — and every close the
-- reconciler lifted from `closed_unknown`, which records no wallet — would
-- otherwise stay on the feed's fallback: resolving `settlement_authority`
-- through today's wallets and today's mapping, the re-resolution this column
-- exists to avoid, and the one a rotated mapping or a same-key duplicate
-- answers wrongly. The audit ledger has held the durable answer since
-- PRO-1992: every settle and cancel that returned a signature logged one row
-- naming the wallet the handler authorized, whose key signed. The signature
-- match pins the row to the close that landed — an unconfirmed broadcast
-- carries a different signature than the close the trade recorded — and the
-- audited organization must be the trade's own, because a close is only ever
-- resolved and signed inside the trade's tenant, as is the wallet it names.
-- A recorded wallet is never second-guessed, and attribution is the only fact
-- that changes, so `updated_at` stands.
UPDATE dvp_trades t
   SET close_custody_wallet_id = a.metadata::jsonb ->> 'settlementCustodyWalletId'
  FROM audit_logs a
 WHERE a.resource_type = 'dvp_trade'
   AND a.resource_id = t.id
   AND a.action IN ('settle', 'cancel')
   AND a.status = 'success'
   AND a.organization_id = t.organization_id
   AND a.metadata IS NOT NULL
   AND pg_input_is_valid(a.metadata, 'jsonb')
   AND a.metadata::jsonb ->> 'signature' IS NOT NULL
   AND a.metadata::jsonb ->> 'signature' = t.close_signature
   AND a.metadata::jsonb ->> 'settlementCustodyWalletId' IS NOT NULL
   AND t.close_signature IS NOT NULL
   AND t.close_custody_wallet_id IS NULL
   AND EXISTS (
     -- The named wallet must still exist and still belong to the trade's
     -- tenant: the close row carries the id into every tenant-scoped read of
     -- the feed, so a stale or foreign id must not be copied even from an
     -- audit row that otherwise matches.
     SELECT 1
       FROM custody_wallets w
       LEFT JOIN custody_configs cfg ON cfg.id = w.custody_config_id
       LEFT JOIN custody_connections conn ON conn.id = w.custody_connection_id
      WHERE w.id = (a.metadata::jsonb ->> 'settlementCustodyWalletId')
        AND (cfg.organization_id = t.organization_id
             OR conn.organization_id = t.organization_id)
   );
