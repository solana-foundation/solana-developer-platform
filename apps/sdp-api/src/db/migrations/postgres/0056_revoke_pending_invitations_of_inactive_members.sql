-- Removing a member now revokes their outstanding pending invitations in the
-- same transaction (routes/members/handlers.ts), because a pending invitation
-- that survives the removal is a self-reinstatement token: acceptance
-- reinstates an inactive membership at the invited role, so a leftover
-- invitation would let a removed member walk straight back in — possibly at a
-- higher role than they ever held.
--
-- Members removed before that rule shipped may still have such invitations
-- pending; this revokes them. Matched on every address acceptance would accept
-- from the member — the users row and any auth identity — mirroring how the
-- caller's email is resolved at acceptance time. A legitimate re-invite issued
-- after this runs creates a new pending row and is unaffected, exactly as it
-- would be for a removal happening today.
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
