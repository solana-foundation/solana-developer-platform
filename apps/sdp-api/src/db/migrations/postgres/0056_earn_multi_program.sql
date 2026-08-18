-- Solana Earn: many concurrent programs per provider (PRO-1670).
--
-- Decision: an organization may run N single-vault programs with the same
-- provider in one environment. 0049 capped it at ONE, and its comment stated the
-- model being retired -- "choosing a curator re-weights the shared wallet's
-- strategy, it never provisions a second wallet". Composed with PRO-1667's
-- single-vault cap (one allocation entry per token group), that one-program cap
-- meant a customer could hold exactly one strategy and had no path to a second.
-- Multiplicity lives BETWEEN programs: each program still pins one vault, and
-- nothing rebalances across them.
--
-- 0049 stays as applied history; this migration is forward-only, the same rule
-- 0055 followed for its drops.
--
-- What replaces the dropped constraint, and why it is not a like-for-like swap:
--
-- * The uniqueness moves to (provider, provider_wallet_ref) and becomes GLOBAL,
--   not org-scoped. A provider wallet is a provider-side resource that holds
--   real funds, so it must be claimable by exactly one link row anywhere in the
--   platform -- two organizations pointing at one Ground wallet would each read
--   the other's balance. Global also mirrors 0055's
--   idx_earn_program_withdrawals_provider_reference, which is global for the
--   same reason: provider-side identifiers are not tenant-scoped.
--
-- * It also becomes the create path's replay anchor. Program creation now
--   requires a retry-stable idempotency key derived against
--   (organization, environment, provider); the provider dedupes on that key and
--   answers a retry with the ORIGINAL wallet ref, so the second insert lands on
--   this constraint. A violation here therefore means "this create already
--   succeeded", which the handler answers with the existing program -- NOT the
--   409 that 0049's org-scoped violation meant. Losing that distinction would
--   turn the required idempotency key into the double-send it exists to prevent.
--
-- * The lookup index is NOT restored on the same columns. 0049's comment noted
--   its unique "also serves the getProviderWallet(org, environment, provider)
--   lookup path", but that singular lookup is gone: a program is now addressed
--   by its own id (primary key), and the collection is read as an ordered list
--   per (organization, environment) with provider as an optional filter. The
--   replacement index matches that access pattern instead.
--
-- * Ordering is (created_at, id) ASCENDING: a program keeps its position in the
--   list for life instead of shifting down whenever a sibling is created. That
--   stability is what makes windowed pagination sound while programs are being
--   added (a newest-first order re-shuffles every page boundary under the
--   reader), and it is the property any consumer that tracks "the same program
--   across polls" by position would silently depend on. id breaks the tie
--   because bulk rows share sdp_iso_now() (the lesson 0055 and
--   payment_transfers 0028-0031 already recorded).
--
-- Migration safety: this is transactional (no non-transactional directive), so
-- the ADD CONSTRAINT below either takes or rolls back whole. It FAILS LOUDLY on
-- a database that already holds two rows with the same
-- (provider, provider_wallet_ref) -- which today's schema permitted across
-- organizations. That is deliberate: the duplicate is a real cross-tenant claim
-- on one provider wallet and must be resolved by a human, never auto-pruned by a
-- migration. Find them with:
--   SELECT provider, provider_wallet_ref, count(*), array_agg(organization_id)
--   FROM earn_provider_wallets GROUP BY 1, 2 HAVING count(*) > 1;

ALTER TABLE earn_provider_wallets
    DROP CONSTRAINT IF EXISTS earn_provider_wallets_org_environment_provider_key;

-- One link row per provider-side wallet, platform-wide. Also the create path's
-- replay anchor (see header). A unique INDEX rather than a table constraint,
-- matching every other earn uniqueness rule (0048's catalogue key, 0055's two)
-- — ADD CONSTRAINT has no IF NOT EXISTS and would need the pg_constraint
-- DO-block dance that 0006 and 0021 resort to.
CREATE UNIQUE INDEX IF NOT EXISTS idx_earn_provider_wallets_provider_ref
    ON earn_provider_wallets(provider, provider_wallet_ref);

-- The list path: every program for an (organization, environment), in stable
-- oldest-first order, with provider filtered in memory (a handful of rows per
-- org). Replaces the dropped constraint's incidental index, on the columns the
-- new access pattern actually uses.
CREATE INDEX IF NOT EXISTS idx_earn_provider_wallets_org_environment_created
    ON earn_provider_wallets(organization_id, environment, created_at, id);
