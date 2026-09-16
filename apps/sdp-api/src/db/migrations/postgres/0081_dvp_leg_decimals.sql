-- A leg's mint decimals, so a trade can be displayed in the units a person uses.
--
-- Every amount on a DvP trade is a u64 of base units, which is correct for the
-- chain and unreadable for anyone else: a 1,000 ATD leg reads as 1000000000.
-- The create form already converts, because it knows the mint it just picked;
-- the trade record did not carry the scale forward, so every surface that read a
-- trade back showed raw integers.
--
-- Stored rather than read per request because a mint's decimals cannot change,
-- and because the alternative is two account reads on every list row.
--
-- Nullable on purpose: rows written before this column existed have no honest
-- value for it, and a default of 0 or 6 would be a guess that silently
-- misrepresents an amount by orders of magnitude. A null means "unknown", and
-- the UI falls back to base units exactly as it did before.
ALTER TABLE dvp_trades ADD COLUMN IF NOT EXISTS decimals_a INTEGER;
ALTER TABLE dvp_trades ADD COLUMN IF NOT EXISTS decimals_b INTEGER;
