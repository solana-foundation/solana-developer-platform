-- Solana Earn: remove the Embedded Yield UI builder's persistence.
--
-- The dashboard button builder (styled previews, per-project saved
-- configuration, public engineering-handoff token) is removed in favor of a
-- direct in-dashboard integration guide that needs no persisted state: the
-- guide is derived entirely from the strategy catalogue and rendered to the
-- signed-in workspace, so nothing here has a reader or a writer any more.
--
-- The table held presentation preferences only (strategy id, style, accent
-- color, handoff token) -- no money, no ledger linkage, and no FK from any
-- other table -- so a plain drop is safe. Public handoff links
-- (/embedded-yield/integrate/:token) stop resolving by design; the replacement
-- guide lives behind the dashboard at /dashboard/markets/embedded-yield.

DROP TABLE IF EXISTS earn_button_configurations;
