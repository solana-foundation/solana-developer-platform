# Earn worker health

Worker health summaries report completed scans/passes, active consumers,
interval error counts, maximum queued-action pickup delay and listener state
once a minute per environment. Two-second scheduler wakes emit no success run events. Minute worker summaries
prove completed scans; a wake never proves asynchronous work completed.
Idle observers need no passes; only active stalls and overdue durable work
are actionable.

The minute movement job reads one independent database snapshot of execution,
observation, provider polling/delivery, queued polling/delivery and valuation
obligations. It neither claims rows nor changes financial state. Existing due
indexes and the partial missing-valuation index keep finalized history out of
the read. Snapshot failures never fabricate zero backlog. RPC count for this
telemetry is **0 before, 0 after**.

Recorded queue maturity/deadline controls the useful polling time. Unknown
provider delivery deadlines get a one-day investigation budget; missing
finalized valuation gets one hour. Neither changes fulfillment guarantees.
The companion sdp-infra rules warn on sustained delays, retain recovery and
integrity pages, and require manual resolution for one-shot integrity loss.
