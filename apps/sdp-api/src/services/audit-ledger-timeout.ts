/**
 * How long one audit-ledger checkpoint call may wait on Redis (HOO-2089). The
 * writer awaits Redis inside the transaction that holds the global audit lock,
 * where every other audit writer queues; the shared ioredis client sets no
 * `commandTimeout`, so without this a stalled Redis would hold the lock until
 * each waiting writer hit its 30s `statement_timeout`. A call that times out
 * fails the write like any Redis error, so the transaction rolls back.
 *
 * The calls stay under the lock: the pending witness must be published after
 * the insert seals the next head and before COMMIT, and the lock is what keeps
 * the Redis checkpoint and the PostgreSQL head moving together. Taking Redis
 * out from under it would let two writers interleave witnesses.
 *
 * Its own module so a test can mock it.
 */
export const AUDIT_LEDGER_REDIS_TIMEOUT_MS = 5_000;
