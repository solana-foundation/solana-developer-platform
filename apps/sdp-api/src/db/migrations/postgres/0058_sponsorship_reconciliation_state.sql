-- Sponsorship reconciliation: durable consecutive config-read failure counter.
--
-- A failed Kora config read used to trip the global sponsorship breaker on the
-- first miss, so any transient network blip between the reconciliation job and
-- Kora (instance recycles, VPC connector or NAT churn) disabled sponsorship
-- until an operator or auto-recovery re-enabled it. Per-request admission is
-- already fail-closed while Kora is unreachable, so the immediate trip bought
-- no safety. Reconciliation now skips the tick on a failed read and trips only
-- after several consecutive failures. Job executions are short-lived, so the
-- consecutive counter must survive across runs; this table holds it.

CREATE TABLE IF NOT EXISTS sponsorship_reconciliation_state (
  network TEXT PRIMARY KEY CHECK (network IN ('devnet', 'mainnet')),
  consecutive_config_failures BIGINT NOT NULL DEFAULT 0 CHECK (consecutive_config_failures >= 0),
  updated_at TEXT NOT NULL DEFAULT sdp_iso_now()
);
