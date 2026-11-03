-- sdp:migration-mode: non-transactional
-- One pending invitation per address per organization (HOO-2223, ADR 0012). Inviting claims
-- the address with its INSERT, so a concurrent second invite loses on this index before any
-- Clerk call. Revoking, accepting or expiring the invitation frees the address. 0176 revoked
-- the duplicates this index would refuse. Built CONCURRENTLY because invitations is live.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_invitations_one_pending_per_email
    ON invitations (organization_id, LOWER(email))
    WHERE status = 'pending';
