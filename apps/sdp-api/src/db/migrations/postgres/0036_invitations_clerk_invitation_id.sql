-- Persist Clerk's invitation id against the local invitation row.
--
-- Revocation and reconciliation previously matched Clerk's pending invitations
-- on email. Email is not unique among pending invitations: a second invitation
-- raised for the same address is indistinguishable from the one being revoked,
-- so an ambiguous Clerk response could read that other invitation as proof the
-- target was still live and reopen a token whose own invitation had in fact
-- been revoked. Clerk's id is the only key that identifies exactly one.
--
-- Nullable, and deliberately not backfilled. Clerk's id was never written to
-- the row for invitations created before this column existed, and recovering it
-- from audit metadata would mean casting a free-form TEXT column to jsonb
-- inside a migration. Those rows keep the email-keyed path, which revokes every
-- match and so still holds the invariant that none survive; they also expire
-- within 7 days, so the population is self-clearing.
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS clerk_invitation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_invitations_clerk_invitation_id
  ON invitations(clerk_invitation_id);
