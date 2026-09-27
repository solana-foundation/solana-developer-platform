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

ALTER TABLE private_channel_wallet_revocations
  ADD COLUMN IF NOT EXISTS claim_epoch BIGINT NOT NULL DEFAULT 0;
