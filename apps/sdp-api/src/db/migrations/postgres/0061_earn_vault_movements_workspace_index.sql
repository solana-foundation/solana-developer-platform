-- Workspace-scoped, newest-first access to recorded vault deposits.
--
-- `GET /v1/earn/vault-deposits` exists so a dashboard can re-derive its own
-- in-flight deposits after a reload, the way the custodial side already
-- re-derives withdrawals from its ledger. Before this index that read had no
-- ordered path: 0059 indexes the table for the RECONCILIATION sweep
-- (`idx_earn_vault_movements_unsettled`, a global status scan), for replay
-- (`idx_earn_vault_movements_request`), for the chain
-- (`idx_earn_vault_movements_signature`) and per POSITION
-- (`idx_earn_vault_movements_position_created`) — none of which can serve
-- "this organization's recent deposits in this environment, newest first".
--
-- Column order follows the access pattern rather than the WHERE clause:
-- (organization_id, environment) are always equality-bound, and
-- (created_at DESC, id DESC) is the exact keyset tuple the route pages on, so
-- the page is read in index order and the LIMIT stops the scan. The remaining
-- predicates — the caller's custody-wallet scope and its project — stay heap
-- filters on purpose: `custody_wallet_id` arrives as an IN-list whose length
-- varies per caller, and `project_id` is NULLABLE (ON DELETE SET NULL), so
-- adding either ahead of the sort columns would fragment the index without
-- removing a sort.
--
-- Partial on `direction = 'deposit'`: today every row is a deposit because the
-- vault withdraw path does not exist yet, so this costs nothing now and keeps
-- the index honest when PRO-1702 adds the other direction — a deposits list
-- must never have to skip past withdrawals.
CREATE INDEX IF NOT EXISTS idx_earn_vault_movements_workspace_created
    ON earn_vault_movements (organization_id, environment, created_at DESC, id DESC)
    WHERE direction = 'deposit';
