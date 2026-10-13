-- When a member was removed (HOO-1972). A removed member returns only through
-- an SDP invitation or a Clerk membership created after this instant: an older
-- invitation is a leftover the removal should have revoked, and an older Clerk
-- membership is a leftover of the removal (mirroring a removal into Clerk is
-- best effort) or a stale webhook replay. NULL on a removed row means the
-- removal time is unknown, and such a row returns only through an invitation.
-- Bare TEXT with no CHECK tying it to status, so the previous release can keep
-- removing members while this one rolls out.
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS removed_at TEXT;

-- Stamped with the migration time, so every invitation and Clerk membership
-- that already exists stays a leftover, and a re-invite or Clerk re-add after
-- deploy counts.
UPDATE organization_members
   SET removed_at = sdp_iso_now()
 WHERE status <> 'active' AND removed_at IS NULL;

-- The Clerk membership a row was last admitted through, when admission read it
-- live from Clerk (the webhooks); NULL for a join from a session claim. A Clerk
-- membership deletion applies only to the membership it names, or to a row
-- with none recorded, so a late deletion of an old membership cannot remove a
-- member Clerk has since re-added.
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS clerk_membership_id TEXT;
