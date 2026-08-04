# Audit ledger operations

SDP's `audit_logs` table is an append-only, SHA-256-linked security ledger. PostgreSQL seals every request and system-worker event at insertion time, serializes concurrent writers, rejects updates, deletes, and production truncation, and exposes a full-chain verifier. Every sealed row also writes an append-only record to `audit_ledger_anchors`, so deletion of the newest rows or complete truncation cannot masquerade as a valid shorter chain.

Ordinary required audit writes fail closed. Irreversible issuance operations use two append-only events: a durable intent is required before any provider/on-chain side effect, followed by an outcome. If the outcome write fails after the side effect, the API does not return a misleading retryable failure; the unresolved intent remains durable, emits a structured error, and makes verification fail after a 15-minute reconciliation window.

This implements the application-side controls for threat `SDP-022` and Linear issue `HOO-996`.

## Runtime database contract

The API and scheduled workers must connect with a PostgreSQL role that is `NOSUPERUSER` and `NOBYPASSRLS`. Row-level security is forced on both ledger tables and only `SELECT` and `INSERT` policies exist. Separate mutation and truncate triggers are a second barrier. The API cannot append a new event if the ledger head differs from the anchored head.

Never use the migration/admin credential as `DATABASE_URL` for an API or worker runtime. A superuser or `BYPASSRLS` role is intentionally reported as unsafe by the verification command.

## Verify and anchor

Run with the ordinary API runtime secret:

```sh
pnpm --filter @sdp/api audit:ledger verify
```

The command exits nonzero if the chain/anchor set is invalid, a critical intent is stale and unresolved, or the connected runtime role can bypass the database controls. Store its JSON output in the deployment/operations log. `headHash` is the immutable checkpoint to compare on the next run and to copy to an external incident or change record before privileged maintenance.

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

If `unresolvedCriticalIntents` is nonzero, first reconcile the target transaction from the intent's nested `target` metadata against the issuance transaction record and Solana signature state. Append the missing outcome only after the result is proven. Do not repeat an irreversible operation merely because its outcome record is missing.

Do not repair hashes in place. Recomputing them would destroy the evidence this control exists to preserve.
