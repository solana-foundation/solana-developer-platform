# ADR 0011: Background jobs are Cron Definitions run by the worker

- **Status:** Accepted
- **Date:** 2026-10-19
- **Deciders:** SDP engineering
- **Related:** HOO-2145; `apps/sdp-api/src/cron/`; ADR 0003 (superseded); ADR 0007 (Jobs); sdp-infra `sdp-<env>-worker`

## Context

Recurring background work ran through two schedulers with one tick list. The
always-on `sdp-<env>-worker` Cloud Run service runs node-cron in process; the
`sdp-<env>-api-public-cron` Cloud Run Job runs `job.ts` on Cloud Scheduler. The
job has been paused in every environment since the worker shipped, yet both
paths stayed in the code with different ordering, fatality, and gating rules.
Gates lived in three places (at registration in `runner.ts`, inside the job, per
row), cluster fan-out ran inside one tick against ADR 0007's per-cluster
registration, and the monitoring identity still carried Sentry Cron Monitor
names and a no-op `Observability` layer.

## Decision

- **The worker is the only scheduler.** `job.ts` and the paused Cloud Run Jobs
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

## Considered options

- **Keep `job.ts` as break-glass.** Rejected: paused since the worker shipped,
  already out of step with it, and a second ordering policy to maintain.
- **A central table of all crons.** Rejected for per-file definitions: each
  cron's facts live beside its work.
- **Gating `finishes` crons out of the type.** Rejected as overhead: `enabled`
  is a plain decision, and review keeps Money Exits always on.
- **Skip disabled crons silently.** Rejected for now: liveness alerts would need
  per-environment floors that move with every flag flip.
