-- Durable tri-state for settled metadata-authority updates (SOLA9-574).
--
-- `metadata_authority` is NULL both for legacy rows that never stored a
-- separate authority and for settled `role=metadata,newAuthority=null`
-- revocations, so ordinary reads could not tell "unset" from "revoked" and
-- reconstructed the mint authority for both — reporting a revoked metadata
-- capability as owned by the mint signer.
--
-- `metadata_authority_revoked = 1` records the explicit revocation; the mint
-- fallback keeps applying only while it is 0. Rows start at 0, which keeps
-- today's fallback for tokens that never stored a separate authority — but it
-- would also keep that fallback for revocations that settled before this
-- migration, so those are backfilled below: the settled mirror marked its
-- transactions processed (`authority_bookkeeping_applied_at`), which means the
-- runtime will never look at them again and only this backfill can set their
-- flag.

ALTER TABLE issued_tokens
    ADD COLUMN IF NOT EXISTS metadata_authority_revoked INTEGER NOT NULL DEFAULT 0;

-- Backfill historical settled revocations.
--
-- The newest bookkept settled `role=metadata` update decides — an older
-- revocation that a later grant superseded must stay granted — with the same
-- (slot, created_at, id) recency ordering the mirror itself uses. The stored
-- column must be NULL: that is what makes reads fall back to the mint
-- authority, and a token re-granted through another write path must keep the
-- authority it was given.
--
-- Confirmed updates that were never bookkept stay out of the decision: the
-- runtime mirror still owns them and will set (or clear) the flag from the
-- settled transaction record when it applies. Until then the revocation reads
-- as "no authority" rather than resurrecting the mint signer, which is the
-- fail-closed side of the mirror's eventual consistency.
WITH bookkept_metadata_updates AS (
    SELECT
        it.token_id,
        it.operation_params::jsonb ->> 'newAuthority' AS new_authority,
        ROW_NUMBER() OVER (
            PARTITION BY it.token_id
            ORDER BY it.slot DESC NULLS LAST, it.created_at DESC, it.id DESC
        ) AS recency
    FROM issuance_transactions it
    WHERE it.type = 'update_authority'
      AND it.status = 'confirmed'
      AND it.authority_bookkeeping_applied_at IS NOT NULL
      AND it.operation_params::jsonb ->> 'role' = 'metadata'
)
UPDATE issued_tokens t
SET metadata_authority_revoked = 1
FROM bookkept_metadata_updates u
WHERE u.token_id = t.id
  AND u.recency = 1
  AND u.new_authority IS NULL
  AND t.metadata_authority IS NULL;
