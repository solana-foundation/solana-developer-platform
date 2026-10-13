-- When a member was removed (HOO-1972). Without an SDP invitation, a removed
-- member returns only through a Clerk membership created after this instant:
-- an older Clerk membership is a leftover of the removal (mirroring a removal
-- into Clerk is best effort) or a stale webhook replay, never a re-add. NULL on
-- a removed row means the removal time is unknown, and such a row returns only
-- through an invitation. Bare TEXT with no CHECK tying it to status, so the
-- previous release can keep removing members while this one rolls out.
ALTER TABLE organization_members ADD COLUMN IF NOT EXISTS removed_at TEXT;

-- Stamped with the migration time, so a Clerk membership that already existed
-- stays a leftover and a re-add from the Clerk dashboard after deploy counts.
UPDATE organization_members
   SET removed_at = sdp_iso_now()
 WHERE status <> 'active' AND removed_at IS NULL;

-- Organization deletion now revokes pending invitations in the same
-- transaction (APE-367); this does the same for organizations deleted before
-- that rule shipped, whose invitations could still redeem into the tenant.
UPDATE invitations
   SET status = 'revoked'
 WHERE status = 'pending'
   AND organization_id IN (SELECT id FROM organizations WHERE status = 'deleted');

-- 0056 again, for members removed since it ran: Clerk membership deletion did
-- not revoke pending invitations until this release (APE-342), and a pending
-- invitation reinstates a removed member.
UPDATE invitations AS i
   SET status = 'revoked'
 WHERE i.status = 'pending'
   AND EXISTS (
     SELECT 1
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       LEFT JOIN auth_user_identities aui ON aui.user_id = u.id
      WHERE om.organization_id = i.organization_id
        AND om.status <> 'active'
        AND (LOWER(u.email) = LOWER(i.email) OR LOWER(aui.email) = LOWER(i.email))
   );
