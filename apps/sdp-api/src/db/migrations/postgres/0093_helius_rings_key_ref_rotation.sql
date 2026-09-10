-- Staging slot so a re-key can put back what it replaced.
--
-- Rotation has to seal the new material before the gateway publishes, because the
-- identity it publishes is derived from those bytes. That made the gateway call a
-- point of no return: a failed signature or submission left the wallet advertising
-- a shielded_address its stored keys no longer derive, with the old keys already
-- deleted and unrecoverable.
--
-- Holding the replaced blob on the same row lets a failed publish restore it, so
-- the destructive step is the chain write rather than the database write. One slot
-- rather than a history: only the immediately previous material can still match a
-- published identity, and a re-key motivated by key compromise must not leave the
-- compromised bytes lying around, so the slot is cleared as soon as the new
-- identity is on chain.
--
-- Nullable and unconstrained by design: the steady state is empty, and a row with
-- a full slot is mid-rotation.
ALTER TABLE helius_rings_key_refs
    ADD COLUMN IF NOT EXISTS previous_ciphertext TEXT,
    ADD COLUMN IF NOT EXISTS previous_key_version TEXT;

COMMENT ON COLUMN helius_rings_key_refs.previous_ciphertext IS
    'Material this row replaced during an in-flight re-key, restored if the publish fails and cleared once it lands. Non-null means a rotation is in progress.';
