# Audit ledger operations

SDP's `audit_logs` table is an append-only, SHA-256-linked security ledger. PostgreSQL seals every request and system-worker event at insertion time, serializes concurrent writers, rejects updates, deletes, and production truncation, and exposes a full-chain verifier. Audit write failures propagate to callers; they are never logged and ignored.

This implements the application-side controls for threat `SDP-022` and Linear issue `HOO-996`.

## Runtime database contract

The API and scheduled workers must connect with a PostgreSQL role that is `NOSUPERUSER` and `NOBYPASSRLS`. Row-level security is forced on the table and only `SELECT` and `INSERT` policies exist. The mutation and truncate triggers are a second independent barrier.

Never use the migration/admin credential as `DATABASE_URL` for an API or worker runtime. A superuser or `BYPASSRLS` role is intentionally reported as unsafe by the verification command.

## Verify and anchor

Run with the ordinary API runtime secret:

```sh
pnpm --filter @sdp/api audit:ledger verify
```

The command exits nonzero if the chain is invalid or the connected runtime role can bypass the database controls. Store its JSON output in the deployment/operations log. `headHash` is the immutable checkpoint to compare on the next run and to copy to an external incident or change record before privileged maintenance.

Verify:

- after every deployment and migration;
- daily from a monitored job;
- immediately before and after backup restore, import, or database maintenance;
- during every audit-integrity alert investigation.

## Privileged maintenance evidence

Record who performed the operation and why, then capture the resulting head hash:

```sh
pnpm --filter @sdp/api audit:ledger checkpoint \
  --operator security@example.com \
  --reason "pre-restore checkpoint" \
  --ticket SEC-123
```

Run a checkpoint both before and after maintenance. The checkpoint itself is an immutable ledger entry. Do not disable the security triggers in production. If emergency recovery requires privileged mutation, preserve the pre-change database snapshot and both externally stored verifier reports, then treat the event as a security incident.

## Retention and recovery

The current enforced retention policy is indefinite. Age alone never authorizes deletion: the database rejects mutation of old entries exactly as it rejects new ones. Capacity relief must use a reviewed archive design that preserves the complete ordered rows, verifier inputs, and externally anchored head hash before any future retention migration is approved.

On a verification failure:

1. Stop value-moving and compliance-changing operations.
2. Preserve a database snapshot and the verifier output.
3. Compare the current and last externally stored head hashes.
4. Identify the first invalid sequence reported by the command.
5. Restore only from a known-good snapshot under an incident record.
6. Re-run verification, append a post-recovery checkpoint, and rotate any database credential capable of bypassing row security.

Do not repair hashes in place. Recomputing them would destroy the evidence this control exists to preserve.
