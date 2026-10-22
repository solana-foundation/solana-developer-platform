import assert from "node:assert/strict";
import type { DatabaseClient, DatabaseExecutor } from "@/db/client";
import { deferred } from "@/test/helpers/deferred";

/** Runs `work` in a transaction left open, holding its row locks, until `commit` is called. */
export async function holdTransaction(
  db: DatabaseClient,
  work: (tx: DatabaseExecutor) => Promise<void>
): Promise<{ commit: () => Promise<void> }> {
  const held = deferred<void>();
  const released = deferred<void>();
  const transaction = db.transaction(async (tx) => {
    await work(tx);
    held.resolve();
    await released.promise;
  });
  await Promise.race([held.promise, transaction]);
  return {
    commit: async () => {
      released.resolve();
      await transaction;
    },
  };
}

/** Waits until `count` statements containing `fragment` are blocked on a lock in this database. */
export async function untilLockWaiters(
  db: DatabaseClient,
  waiters: { fragment: string; count: number }
): Promise<void> {
  for (let attempt = 0; attempt < 250; attempt++) {
    const waiting = await db.queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM pg_stat_activity
        WHERE wait_event_type = 'Lock'
          AND datname = current_database()
          AND pid <> pg_backend_pid()
          AND position(? in query) > 0`,
      [waiters.fragment]
    );
    assert(waiting);
    if (waiting.count >= waiters.count) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Fewer than ${waiters.count} statements containing ${waiters.fragment} waited`);
}
