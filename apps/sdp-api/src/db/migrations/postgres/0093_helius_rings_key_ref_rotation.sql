-- Staging slot so a re-key can put back what it replaced.
--
-- Rotation has to seal the new material before the gateway publishes, because the
-- identity it publishes is derived from those bytes. That made the gateway call a
-- point of no return: a failed signature or submission left the wallet advertising
-- a shielded_address its stored keys no longer derive, with the old keys already
-- deleted and unrecoverable.
--
-- Holding the replaced blob on the same row keeps both possible chain outcomes
-- recoverable while publication is ambiguous. A gateway rejection is not evidence
-- that nothing landed, so it is never restored automatically: retry reuses the
-- staged pair when the registry is still foreign, or reconciliation commits it
-- when the registry matches. One slot rather than a history: only the immediately
-- previous material can still match the other possible outcome, and a re-key
-- motivated by key compromise must not leave those bytes lying around once the new
-- identity is confirmed on chain.
--
-- Nullable and unconstrained by design: the steady state is empty, and a row with
-- a full slot is mid-rotation.
ALTER TABLE helius_rings_key_refs
    ADD COLUMN IF NOT EXISTS previous_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS previous_key_version TEXT;

COMMENT ON COLUMN helius_rings_key_refs.previous_ciphertext IS
    'Material this row replaced during an in-flight re-key, retained while publication is ambiguous and cleared once the staged identity is confirmed on chain. Non-null means a rotation is in progress.';

-- Registered transfers and re-key exclusion resolve a recipient by its current
-- shielded identity. Keep that point lookup independent of the paginated wallet
-- list and cheap as a project grows.
CREATE UNIQUE INDEX IF NOT EXISTS idx_helius_rings_wallets_project_shielded
    ON helius_rings_wallets(organization_id, project_id, shielded_address)
    WHERE shielded_address IS NOT NULL;
