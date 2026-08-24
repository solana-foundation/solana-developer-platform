-- Deactivate API keys that survived project archival (SDP-003 remediation).
--
-- Before archival revoked credentials, archiving a project only flipped its
-- status: API keys stayed active and kept authenticating. New archives revoke
-- keys transactionally in the application; this backfill closes the hole for
-- projects archived before that behavior shipped.
--
-- Warm KV cache entries for these keys are not purged here — the cache lives
-- outside Postgres — but the authentication backstop rejects any key whose
-- project is not active once its entry expires (≤ 1 hour TTL).
UPDATE api_keys
   SET status = 'deactivated',
       revoked_at = sdp_iso_now()
 WHERE status = 'active'
   AND project_id IN (SELECT id FROM projects WHERE status = 'archived');
