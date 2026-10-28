# Project movement control

HOO-2334 adds an operator-only stop for one start movement in one project.
The SDP on-call owns the incident action; record the human operator, reason,
and incident or Linear ticket. Use the deployment's normal secret injection
and a runtime database role with audit-ledger access. Do not use a migration
credential for routine operation.

The command runs in `apps/sdp-api`, using the same environment as the target
API deployment. Check the organization and project ids before changing state.

```sh
pnpm --filter @sdp/api movement:control status \
  --organization-id ORG_ID --project-id PROJECT_ID

pnpm --filter @sdp/api movement:control disable \
  --organization-id ORG_ID --project-id PROJECT_ID \
  --movement payments.transfer_batch --operator ops:NAME \
  --reason 'INCIDENT_REASON' --ticket HOO-2334
```

Run `status` again and confirm the movement is in `disabledMovements` and the
version increased. A refused start emits `sdp_money_refused` with reason
`movement_disabled`. Confirm the intended project and movement refuse, an
unaffected project and movement still start, and an exit still works. For
recurring collections, confirm the refused period is recorded as skipped.

To re-enable, read the current version immediately before the command:

```sh
pnpm --filter @sdp/api movement:control enable \
  --organization-id ORG_ID --project-id PROJECT_ID \
  --movement payments.transfer_batch --expected-version VERSION \
  --operator ops:NAME --reason 'INCIDENT_RESOLVED' --ticket HOO-2334
```

If the version changed, inspect the new status and incident record before
retrying. Each state change and its reason are committed atomically with a
project audit-ledger entry. If the audit ledger is unavailable, the command
fails without changing the control. Do not bypass that failure with a direct
database edit.

This control is read at each start admission and signing waist. It does not
cancel a transaction whose admission read already completed, a signature
already handed to a provider, or an existing provider authorization. For a
hard external stop, apply the custody-provider policy as well. Exits remain
available; do not disable them through this command.

## Stage drill before production use

Deploy the candidate API and Worker to stage and confirm `/health/ready` reports
its SHA. The stage deployment runs migration `0189` before replacing either
service. Use a dedicated Sandbox project and a second project in the same
organization; do not disable the shared stage smoke project. Use devnet wallets
and test amounts only. The operator CLI needs the stage runtime database role
and network access to stage Postgres. Verify the injected `DATABASE_URL` targets
stage and uses that role before running it; do not infer this from the Doppler
config name.

1. Record the SHA, organization and project ids, both `status` outputs, and the
   control version before the stop.
2. Disable `payments.transfer_batch` on the dedicated project. Confirm its
   version increments and the movement appears in `disabledMovements`.
3. Try a new batch with a fresh Idempotency-Key. Expect HTTP 403 with
   `details.reason = movement_disabled`, no batch row, and no sponsor signature.
   Retry that same key after re-enable to prove the refusal was not stored.
4. Check an unaffected project and a different movement can still start.
   Check a credentialed exit, such as recurring cancellation, still works.
5. Try re-enabling with the version from step 1. It must fail. Read the current
   version, re-enable with it, and confirm the control is clear.
6. Confirm the disable and enable audit-ledger entries name the operator,
   reason, ticket, movement, and before/after versions. Record the stage smoke
   result and evidence in HOO-2334.

The next batch chunk is checked at the sponsor waist. The deterministic
stop-between-chunks integration test covers that race; a manual stage request
cannot reliably pause between concurrent chunks. Already signed chunks may
still broadcast, so inspect their transfer rows before treating a batch as
fully stopped.
