-- One pending invitation per address per organization (HOO-2223, ADR 0012). Invitations were
-- checked with a read before the insert, so concurrent invites to one address could both land;
-- admission then picked the newest, and revoking the visible one left the other live. This
-- keeps the newest pending invitation per (organization_id, lower(email)) and revokes the rest,
-- so 0161 can build its unique index.
UPDATE invitations AS i
   SET status = 'revoked'
  FROM (
         SELECT id,
                ROW_NUMBER() OVER (
                  PARTITION BY organization_id, LOWER(email)
                  ORDER BY created_at DESC, id DESC
                ) AS position
           FROM invitations
          WHERE status = 'pending'
       ) AS ranked
 WHERE i.id = ranked.id
   AND i.status = 'pending'
   AND ranked.position > 1;
