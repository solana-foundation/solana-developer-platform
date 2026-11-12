-- sdp:migration-compat: breaking
-- Batches take no execution options; nothing reads or writes options any more. Its CHECK constraint
-- drops with it. Breaking for a traffic rollback: an image from before that change writes the column.
ALTER TABLE payment_transfer_batches DROP COLUMN IF EXISTS options;
