# ADR 0003: Managed reconciliation cadence and monitor identity

- **Status:** Accepted
- **Date:** 2026-08-22
- **Deciders:** SDP API and Infrastructure teams
- **Related:** `apps/sdp-api/src/job.ts`; `apps/sdp-api/src/cron/`; sdp-infra `sdp_api_cron_schedule`; Sentry issues SDP-API-5, SDP-API-H, SDP-API-J, SDP-API-P, and SDP-API-X

## Context

The managed Cloud Run reconciliation job and its Sentry Cron monitors currently
define their schedules independently. Production infrastructure executes the job
with `*/3 * * * *`, while `src/job.ts` tells most managed monitors to expect
`*/5 * * * *`. The pending-transfers monitor is also reused by an in-process
reporter configured for `* * * * *`. Because Sentry monitor configuration is
updated by monitor slug and environment, either reporter can replace the other's
schedule.

Those mismatches produced five production `missed` issues even though ordinary
callback failures are reported as `error`. Copying the current production value
into the API would quiet four issues temporarily, but it would preserve two
independent sources of truth and would not fix the shared-slug collision.

The managed job also runs reconcilers sequentially. Starting each Sentry monitor
only when its callback reaches the front of that queue can make a healthy later
reconciler appear late when an earlier one runs long.

## Decision

### 1. Infrastructure owns the Managed Reconciliation Cadence

The deployment schedule is the source of truth. sdp-infra will inject the same
`sdp_api_cron_schedule` value used by Cloud Scheduler into the reconciliation
job container as `SDP_MANAGED_RECONCILIATION_CRON`. It also projects the Cloud
Run task timeout as `SDP_MANAGED_RECONCILIATION_TIMEOUT_SECONDS`; migration jobs
receive neither reconciliation-only value.

The managed API job will require and validate that value at startup and use it for
managed monitor configuration. It will have no hard-coded fallback. Self-hosted
and opted-in web services keep their reconciler-specific cron values; those are a
different execution path and are not the Managed Reconciliation Cadence.

### 2. Managed and in-process reporters have different monitor identities

Managed monitor slugs will use a stable `sdp-api-managed-<reconciler>` namespace.
Existing in-process monitor slugs remain unchanged. A logical reconciler can then
have different managed and self-hosted cadences without either reporter mutating
the other's Sentry configuration.

### 3. A managed run registers cadence-bound check-ins before work begins

After feature gates are evaluated, orchestration will send an `in_progress`
check-in for every reconciler identity governed by the Managed Reconciliation
Cadence and retain each returned check-in ID. A feature-disabled reconciler is
a successful no-op for monitor-lifecycle purposes; this prevents a monitor
created while a feature was enabled from becoming permanently missed when the
flag is turned off. Existing execution ordering and intentional sibling
concurrency remain unchanged. Each callback completes its own ID as `ok` or
`error`; a process exit leaves outstanding IDs to time out.

This defines `in_progress` as "accepted by this managed run", not "callback is now
first in the local queue". It preserves per-reconciler liveness while removing
queue position from Sentry's scheduling judgment. Monitor `maxRuntime` is
derived from the infrastructure-provided Cloud Run timeout, rounded up to
Sentry's minute unit.

A task with its own slower cadence, such as the hourly Redis-slotted Earn
catalogue sync, retains that frequency but reports through the managed monitor
namespace so it cannot overwrite its in-process counterpart. The in-process
reporter keeps its wall-clock `0 * * * *` crontab; the managed reporter expresses
the rolling Redis lease as a one-hour interval with a ten-minute check-in
margin. Because the lease lasts 59 minutes, the managed scheduler grid must
have no gap larger than five minutes; this leaves another five minutes of
delivery-jitter tolerance. The job rejects an otherwise-valid cron that cannot
satisfy that bound, and sdp-infra restricts its standard Scheduler expression
to every one through five minutes so an incompatible cadence fails before
deployment.

### 4. Roll out and verify without executing production work as a smoke test

1. Deploy the infrastructure environment value first; the old API safely ignores
   it.
2. Deploy the API that validates the value, uses managed slugs, and completes
   explicit check-in IDs.
3. Compare the Cloud Scheduler schedule with the Cloud Run job environment value
   during deployment. Do not invoke the reconciliation job merely to test wiring.
4. Observe successful check-ins for at least two managed cadences, then archive
   or mute the superseded production monitors by following
   [`docs/ops/managed-reconciliation-monitor-migration.md`](../ops/managed-reconciliation-monitor-migration.md).

Tests will provide the cadence as input and assert propagation and validation;
they will not assert a fixed minute count.

## Alternatives considered

- **Change the API constant from `*/5` to `*/3`.** Rejected: it repairs today's
  value but keeps cross-repository drift structurally possible.
- **Keep shared monitor slugs and rely on identical schedules.** Rejected:
  self-hosted and managed paths legitimately have different cadences.
- **Use one job-level monitor only.** Rejected: simpler, but it loses detection of
  a single reconciler being omitted or never completed.
- **Run all reconcilers concurrently.** Rejected: monitoring must not change the
  ordering or overlap behavior of money-moving work.
- **Create one Cloud Run job per reconciler.** Deferred: it aligns schedules and
  monitors naturally, but multiplies deployment resources and operational surface
  beyond what this incident requires.

## Consequences

- A schedule change is made once in sdp-infra and reaches both execution and
  monitoring.
- Managed and self-hosted monitors no longer overwrite one another.
- A missing or invalid cadence becomes a visible startup configuration failure
  instead of silently falling back to a stale value.
- Explicit check-in lifecycle handling is more code than `withMonitor`, but it
  preserves sequential execution and per-reconciler diagnostics.
- The old monitor history remains available under the old slugs; production
  alerting moves to the managed namespace after the observation window.
