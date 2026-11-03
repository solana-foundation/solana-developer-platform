-- Nothing redeems an invitation token since the accept route went; the invite handler stops writing it next.
ALTER TABLE invitations ALTER COLUMN token_hash DROP NOT NULL;
