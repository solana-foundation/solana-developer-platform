-- sdp:migration-compat: breaking
-- Nothing reads or writes token_hash any more; its UNIQUE constraint and idx_invitations_token drop with it.
ALTER TABLE invitations DROP COLUMN IF EXISTS token_hash;
