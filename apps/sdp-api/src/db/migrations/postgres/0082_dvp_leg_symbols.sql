-- A leg's token symbol, so a trade reads as "1,000 ATD" rather than "1,000".
--
-- Companion to 0081's decimals and stored for the same reason: the symbol comes
-- from the mint's own Token-2022 metadata, cannot change for a given mint, and
-- is otherwise unavailable to any surface reading a trade back. Without it the
-- amounts are correctly scaled and still unattributed — a number with no unit,
-- on a screen showing two different tokens side by side.
--
-- Nullable: a mint carrying no metadata extension genuinely has no symbol, and
-- the UI falls back to the mint address rather than inventing a name.
ALTER TABLE dvp_trades ADD COLUMN IF NOT EXISTS symbol_a TEXT;
ALTER TABLE dvp_trades ADD COLUMN IF NOT EXISTS symbol_b TEXT;
