# Managed reconciliation monitor migration

Use this runbook after deploying the managed reconciliation monitor-identity
change. Deployment creates new monitors; it deliberately does not delete the
old monitors before the new path proves it is alive.

## Observation gate

Keep the incident open until all of these are true in Sentry's `production`
environment:

1. Each new managed monitor below has two consecutive `ok` check-ins from the
   deployed release (feature-conditional monitors report successful no-ops
   while disabled).
2. Every cadence-bound monitor shows the same crontab as the production Cloud
   Scheduler job and a `maxRuntime` at least as long as the Cloud Run task
   timeout.
3. The managed Earn catalogue monitor has hourly interval configuration, a
   ten-minute check-in margin, and an `ok` work or no-op check-in. Its rolling
   Redis lease is intentionally not phase-locked to the in-process reporter's
   `0 * * * *` wall-clock schedule.
4. No new `missed`, `timeout`, or callback-error issue appeared during the
   observation window.

Record the two check-in timestamps and deployed release SHA in the incident.

| Superseded monitor | Replacement monitor |
| --- | --- |
| `sdp-api-track-pending-transfers` | `sdp-api-managed-track-pending-transfers` |
| `sdp-api-collect-recurring-payments` | `sdp-api-managed-collect-recurring-payments` |
| `sdp-api-track-pending-deposits` | `sdp-api-managed-track-pending-deposits` |
| `sdp-api-track-pending-withdrawals` | `sdp-api-managed-track-pending-withdrawals` |
| `sdp-api-poll-rings-indexing` | `sdp-api-managed-poll-rings-indexing` |
| `sdp-api-reconcile-earn-vault-movements` | `sdp-api-managed-reconcile-earn-vault-movements` |
| `sdp-api-refresh-earn-metrics` | `sdp-api-managed-refresh-earn-metrics` |
| `sdp-api-sync-earn-catalogue` | `sdp-api-managed-sync-earn-catalogue` |
| `sdp-api-run-workflow-executions` | `sdp-api-managed-run-workflow-executions` |
| `sdp-api-retire-workflow-secrets` | `sdp-api-managed-retire-workflow-secrets` |

## Retirement

After the observation gate passes, inventory every old monitor above. These
slugs remain the supported identity for self-hosted and explicitly opted-in
in-process reporters, so first inspect post-deploy check-in release metadata:

- If a legitimate in-process production reporter still checks in, preserve the
  old monitor and verify its configured schedule matches that reporter. Confirm
  that no managed release writes it.
- If no in-process reporter owns it, disable alerting for or archive it while
  preserving issue/check-in history.

Resolve the original SDP-API-5/H/J/P/X issues only after every old slug has one
of those recorded dispositions and cannot receive conflicting managed and
in-process configurations.

## Rollback

A rollback to an image from before this change restores the old hard-coded
schedule and monitor slugs even though infrastructure cadence parity still
passes. Treat that as an incident rollback, not a compatible steady state:
mute the new managed monitors while the old image runs, redeploy the fixed
image, then repeat the two-cadence observation gate before retiring the old
monitors again.
