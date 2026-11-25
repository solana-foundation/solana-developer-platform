# ADR 0011: Background jobs are Cron Definitions run by the cron service

> **Note (2026-11-17):** The always-on service this ADR first called the worker
> is now the cron service, `sdp-<env>-cron` (PRO-2519). Only the name changed;
> the decision stands as written.
- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** SDP engineering
- **Related:** HOO-2145; `apps/sdp-api/src/cron/`; ADR 0003 (superseded); ADR 0007 (Jobs); sdp-infra `sdp-<env>-cron`

## Context

Recurring background work ran through two schedulers with one tick list. The
always-on `sdp-<env>-cron` Cloud Run service runs node-cron in process; the
`sdp-<env>-api-public-cron` Cloud Run Job runs `job.ts` on Cloud Scheduler. The
job has been paused in every environment since the cron service shipped, yet both
paths stayed in the code with different ordering, fatality, and gating rules.
Gates lived in three places (at registration in `runner.ts`, inside the job, per
row), cluster fan-out ran inside one tick against ADR 0007's per-cluster
registration, and the monitoring identity still carried Sentry Cron Monitor
names and a no-op `Observability` layer.

## Decision

- **The cron service is the only scheduler.** `job.ts` and the paused Cloud Run Jobs
  and Schedulers are deleted, not kept as break-glass: an unexercised fallback
  drifts and is one more dependency to trust.
- **Each Cron Definition lives in its own file**, built with `defineCron`: a
  stable `name`, a `schedule`, a `scope`, its money `effect`, an
  `enabled(env)` decision, the `run` work, and optionally `runOnStart`. The
  runner only lists the definitions; there is no central table of gates or
  effects.
- **Scope is `cluster` or `global`.** A `cluster` definition is registered once
  per Environment and each registration opens its own cluster scope (ADR 0007),
  selecting only that environment's rows. A `global` definition touches no
  shared cluster RPC.
- **`enabled` is decided once, at registration.** A disabled definition still
  logs `sdp_cron_run` with `status: "disabled"` on its schedule, so liveness
  alerts count a fixed set of crons.
- **A definition never overlaps itself in process.** A slot that fires while
  the previous run is in flight is skipped and logged as `skipped_overlap`;
  with `duration_ms`, that shows whether a cadence is too tight. A 10-minute
  slot deadline frees the registration and logs `error`, but cancels nothing:
  per-row writers tolerate the abandoned run through claims and
  compare-and-set, and a definition with set- or snapshot-based writes holds
  its own lock until its work settles (the Earn catalogue sync). Real
  cancellation is a follow-up (HOO-2163).
- **Run events go to Loki/Grafana only.** Every run logs `sdp_cron_run` with
  `cron`, `environment` (cluster scope), `status`, and `duration_ms`. The
  leftover Sentry abstraction is removed from sdp-api.

### Earn wakeups (2026-11-24)

The cron service also owns Earn's PostgreSQL notification listener and bounded
consumers. `reconcile-operations` wakes the same consumers every two seconds as
a recovery fallback; it does not wait for a whole batch to finish. Notifications
carry only an environment hint. Durable rows, current principal authorization
and fenced claims remain the authority to execute.

An observation-only lane shares this wakeup and the minute movement sweep's
per-row processing claims. It reads transaction statuses before acquiring a
processing lease, so a slow RPC leaves resend candidates available. It batches
transaction status reads without signing,
rebroadcasting or inferring expiry. Signature misses release their claims before
slow receipt/provider projections, leaving recovery free to retry original
bytes. The cron service's environment and shutdown gates apply to both lanes.
Consumer failures emit error run events independently of the scheduled wake
event. Financial reducers and expiry recovery are shared with the existing
sweep.

Recovery batches chain reads before taking four-row claims for ready reducers.
The read reserves nothing, so a slow provider cannot lease the remaining backlog
away from the fast observer. Evidence is local to that sweep and checked against
the fresh claimed transaction; changed state invalidates earlier absence proof.
No extra queue or persistent evidence cache is introduced.

## Considered options

- **Keep `job.ts` as break-glass.** Rejected: paused since the cron service shipped,
  already out of step with it, and a second ordering policy to maintain.
- **A central table of all crons.** Rejected for per-file definitions: each
  cron's facts live beside its work.
- **Gating `finishes` crons out of the type.** Rejected as overhead: `enabled`
  is a plain decision, and review keeps Money Exits always on.
- **Skip disabled crons silently.** Rejected for now: liveness alerts would need
  per-environment floors that move with every flag flip.
