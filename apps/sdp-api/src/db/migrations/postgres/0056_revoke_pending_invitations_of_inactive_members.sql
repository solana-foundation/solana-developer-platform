-- A pending invitation that survives a member's removal is a self-reinstatement
-- token: acceptance reinstates inactive rows at the invited role. Removal now
-- revokes them in the same transaction (routes/members/handlers.ts); this does
-- the same for members removed before that rule shipped. Matched on every
-- address acceptance honors (users row + auth identities). A re-invite issued
-- after this runs creates a new pending row and is unaffected.
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
