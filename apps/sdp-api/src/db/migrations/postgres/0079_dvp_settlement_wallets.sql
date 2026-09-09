-- The custody wallet that acts as settlement authority for a project's DvP
-- trades (PRO-1841).
--
-- Only this key can Settle or Cancel a trade; the parties themselves can only
-- unwind their own leg. It replaces the single DVP_SETTLEMENT_AUTHORITY
-- environment key, which gave every tenant the same authority — one compromise
-- would have reached every customer's trades, and because the authority is a
-- PDA seed, every trade ever created would stay bound to it.
--
-- Why a join table rather than a `purpose` on custody_wallets:
--
-- 1. `custody_wallets.purpose` is free-form TEXT with no database constraint,
--    and nothing stops two rows sharing one. Two trade creations racing would
--    mint two settlement authorities, and the second would be silently
--    unusable — every trade created under the first stays bound to the first.
--    A PRIMARY KEY on project_id makes "one per project" a database fact.
--
-- 2. Ownership of a custody wallet is a XOR across custody_config_id and
--    custody_connection_id, and a legacy config can be org-level rather than
--    project-level. A unique index over that split cannot express "one per
--    PROJECT" without picking a side. This can.
--
-- ON DELETE RESTRICT on the wallet is load-bearing: deleting a settlement
-- wallet would strand every open trade that names it, because the authority is
-- fixed in the trade's address and no other key can ever settle it.

CREATE TABLE IF NOT EXISTS dvp_settlement_wallets (
    project_id TEXT PRIMARY KEY,
    organization_id TEXT NOT NULL,
    custody_wallet_id TEXT NOT NULL,

    created_at TEXT NOT NULL DEFAULT sdp_iso_now(),
    updated_at TEXT NOT NULL DEFAULT sdp_iso_now(),

    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE,
    FOREIGN KEY (custody_wallet_id) REFERENCES custody_wallets(id) ON DELETE RESTRICT,

    -- One wallet cannot serve two projects. It could technically sign for both,
    -- but then a compromise crosses the project boundary this table exists to
    -- draw, and that is the whole reason the authority stopped being global.
    UNIQUE (custody_wallet_id)
);
