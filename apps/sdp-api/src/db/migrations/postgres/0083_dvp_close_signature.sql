-- The transaction that closed the trade.
--
-- Create and funding signatures were both recorded; the close was not. That is
-- the wrong one to lose: settling is the moment the trade actually happens, and
-- the signature was returned once in the HTTP response and then existed nowhere
-- — so a refresh left the most consequential transaction of the whole flow with
-- no record and nothing to link to on an explorer.
--
-- Nullable, since an open trade has not been closed.
ALTER TABLE dvp_trades ADD COLUMN IF NOT EXISTS close_signature TEXT;
