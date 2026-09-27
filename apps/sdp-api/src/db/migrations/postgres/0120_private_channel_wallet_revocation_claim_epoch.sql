-- Ownership epoch for pending-revocation retry markers (APE-812 follow-up).
--
-- A cleanup claim records the revocation epoch it advanced to, so everyone
-- reading the marker can tell whether the claiming request's convergence (its
-- compensating SPC delete plus the epoch advance of its local half) has
-- committed: once the live epoch moves past `claim_epoch`, the marker's owner
-- is finished and the marker no longer latches mirror upserts or stands claims
-- down — it only remains as discovery for the principal-disable cleanup until
-- it is taken over or cleared.
--
-- The undecided-cleanup fallback re-owns an existing marker when its bounded
-- wait times out (the marker must survive its owner's watermark-scoped clear
-- so a late binding stays discoverable); the re-own refreshes `updated_at` but
-- preserves `claim_epoch`, so single-flight is kept while the original
-- owner's delete can still be in flight and the latch drops as soon as that
-- owner converges.
--
-- Markers that already exist when this migration runs get no default that
-- reads as converged: `claim_epoch` is backfilled to the identity's CURRENT
-- revocation epoch, so the latch keeps holding until that identity's own
-- convergence advances the epoch past it. Backfilling 0 instead would treat
-- an in-flight cleanup as finished the moment anything advanced the epoch,
-- and a fresh verification could land a mirror whose binding the outstanding
-- delete then removes.

ALTER TABLE private_channel_wallet_revocations
  ADD COLUMN IF NOT EXISTS claim_epoch BIGINT NOT NULL DEFAULT 0;

UPDATE private_channel_wallet_revocations r
   SET claim_epoch = COALESCE(
         (
           SELECT e.epoch
             FROM private_channel_wallet_revocation_epochs e
            WHERE e.user_id = r.user_id
              AND e.instance_id = r.instance_id
              AND e.pubkey = r.pubkey
         ),
         0
       );
