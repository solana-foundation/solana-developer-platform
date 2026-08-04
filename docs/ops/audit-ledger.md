# Audit ledger operations

SDP's `audit_logs` table is an append-only, SHA-256-linked security ledger. PostgreSQL seals every request and system-worker event at insertion time, serializes concurrent writers, rejects updates, deletes, and production truncation, and exposes a full-chain verifier. Every sealed row also writes an append-only record to `audit_ledger_anchors`. The API advances a monotonic head checkpoint in Redis only after the database transaction commits. Because that checkpoint is outside PostgreSQL's privilege boundary, even a database superuser who consistently shortens both PostgreSQL tables leaves detectable evidence.

Ordinary required audit writes fail closed. Irreversible issuance operations use two append-only events: a durable intent is required before any provider/on-chain side effect, followed by an outcome. If the outcome write fails after the side effect, the API does not return a misleading retryable failure; the unresolved intent remains durable, emits a structured error, and makes verification fail after a 15-minute reconciliation window.

This implements the application-side controls for threat `SDP-022` and Linear issue `HOO-996`.

## Runtime storage contract

The API and scheduled workers must connect with a PostgreSQL role that is `NOSUPERUSER` and `NOBYPASSRLS`. Row-level security is forced on both ledger tables and only `SELECT` and `INSERT` policies exist. Separate mutation and truncate triggers are a second barrier. The API cannot append a new event if the ledger head differs from the anchored head.

Never use the migration/admin credential as `DATABASE_URL` for an API or worker runtime. A superuser or `BYPASSRLS` role is intentionally reported as unsafe by the verification command.

The API and every worker must use the same durable Redis deployment through `REDIS_URL`. Compliant writers hold the same PostgreSQL session advisory lock across the database commit and the Redis compare-and-set of `cache:audit-ledger:checkpoint:v1`. The database head must match Redis before insertion, and Redis advances only after the row is durable. A failed database commit therefore never moves Redis. If a process exits after commit but before the compare-and-set, the next writer may advance Redis across exactly that one committed row only after its hash seal, append-only anchor, and Redis-named non-empty predecessor all match under the same lock. A missing checkpoint for any non-empty ledger, or a wider, malformed, unexpectedly advanced, or forked divergence, fails closed. Do not delete, expire, or manually rewrite this key.

## Verify and anchor

Run with the ordinary API runtime database and Redis secrets:

```sh
pnpm --filter @sdp/api audit:ledger verify
```

The command exits nonzero if the chain/anchor set is invalid, PostgreSQL disagrees with the Redis checkpoint, a critical intent is stale and unresolved, or the connected runtime role can bypass the database controls. Store its JSON output in the deployment/operations log. `headHash` remains suitable for an additional incident or change record before privileged maintenance.

After this migration is applied and before API/worker traffic is enabled, record the migration's exact terminal sequence and SHA-256 head in the protected deployment approval. With writers still stopped, initialize Redis once using those independently approved values:

```sh
pnpm --filter @sdp/api audit:ledger bootstrap \
  --expected-sequence 123 \
  --expected-head-hash 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  --operator security@example.com \
  --reason "initial audit-ledger bootstrap" \
  --ticket SEC-123
```

`bootstrap` requires Redis to be absent, verifies the entire sealed database chain and protected runtime role against the supplied values, initializes Redis with `SET NX`, then appends and anchors its own maintenance event. Ordinary `checkpoint` and runtime writes never recreate a missing checkpoint for a non-empty ledger. Do not reuse bootstrap as recovery; loss of an established Redis checkpoint is a security incident.

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

Run a checkpoint both before and after maintenance. The checkpoint itself is an immutable ledger entry and advances the independent Redis head. Do not disable the security triggers in production. If emergency recovery requires privileged mutation, preserve the pre-change database snapshot and both verifier reports, then treat the event as a security incident.

## Retention and recovery

The current enforced retention policy is indefinite. Age alone never authorizes deletion: the database rejects mutation of old entries exactly as it rejects new ones. Capacity relief must use a reviewed archive design that preserves the complete ordered rows, verifier inputs, and externally anchored head hash before any future retention migration is approved.

On a verification failure:

1. Stop value-moving and compliance-changing operations.
2. Preserve a database snapshot and the verifier output.
3. Compare the PostgreSQL head, Redis checkpoint, and last operations-record head hash.
4. Identify the first invalid sequence reported by the command.
5. Restore only from a known-good snapshot under an incident record.
6. Re-run verification, append a post-recovery checkpoint, and rotate any database credential capable of bypassing row security.

If PostgreSQL is one sequence ahead after a post-commit Redis failure, the failed request remains fail-closed. When Redis still contains the non-empty immediate predecessor, the next audit writer automatically verifies the committed row's hash and append-only anchor and advances Redis before appending anything else. If Redis is missing—even when PostgreSQL contains only sequence one—the state is ambiguous and requires the incident procedure above. Never automatically rewind or reseed a checkpoint.

If `unresolvedCriticalIntents` is nonzero, first reconcile the target transaction from the intent's nested `target` metadata against the issuance transaction record and Solana signature state. Append the missing outcome only after the result is proven. Do not repeat an irreversible operation merely because its outcome record is missing.

Do not repair hashes in place. Recomputing them would destroy the evidence this control exists to preserve.
