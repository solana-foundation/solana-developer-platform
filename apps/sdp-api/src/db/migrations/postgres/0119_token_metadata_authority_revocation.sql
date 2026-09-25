-- Durable tri-state for settled metadata-authority updates (SOLA9-574).
--
-- `metadata_authority` is NULL both for legacy rows that never stored a
-- separate authority and for settled `role=metadata,newAuthority=null`
-- revocations, so ordinary reads could not tell "unset" from "revoked" and
-- reconstructed the mint authority for both — reporting a revoked metadata
-- capability as owned by the mint signer.
--
-- `metadata_authority_revoked = 1` records the explicit revocation; the mint
-- fallback keeps applying only while it is 0. Existing rows have never been
-- explicitly revoked, so they all start at 0 and keep today's fallback.

ALTER TABLE issued_tokens
    ADD COLUMN IF NOT EXISTS metadata_authority_revoked INTEGER NOT NULL DEFAULT 0;
