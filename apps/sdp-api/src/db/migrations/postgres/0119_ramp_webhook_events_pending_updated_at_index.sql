-- Replay claims the least-recently-touched pending events first, so an event
-- a pass deferred (or failed) rotates to the back of the queue instead of
-- crowding fresh settlements out of the batch (the claim orders by
-- updated_at, not created_at). Serve that ordering from an index instead of a
-- per-claim sort: each replay pass issues up to
-- RAMP_WEBHOOK_EVENT_REPLAY_BATCH single-row claims, and a backlog of pending
-- rows is exactly when replay is under the most pressure. The partial
-- predicate mirrors the claim's `status = 'pending'` guard; created_at and
-- attempts stay residual filters over the small pending set (applied rows are
-- deleted, so the pending backlog is bounded by the events awaiting apply).

CREATE INDEX IF NOT EXISTS idx_ramp_webhook_events_pending_updated_at
    ON ramp_webhook_events (updated_at)
    WHERE status = 'pending';
