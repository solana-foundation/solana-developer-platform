ALTER TABLE dvp_trades
  ADD COLUMN IF NOT EXISTS observed_cluster_timestamp TEXT;

COMMENT ON COLUMN dvp_trades.observed_cluster_timestamp IS
  'The cluster Clock.unix_timestamp (seconds) read in the same request as the observation at observed_at. Settlement availability (expiry, earliest settlement time) is judged by this, the clock the program reads, never by a host or browser clock. NULL until the first observation that carried a clock.';
