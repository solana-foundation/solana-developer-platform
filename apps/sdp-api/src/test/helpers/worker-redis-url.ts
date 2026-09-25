/**
 * Scopes a Redis URL to the current vitest worker's logical database.
 *
 * A handful of plain-node integration tests talk to raw REDIS_URL rather than
 * the worker-scoped Env (they predate or sit outside the app Env). Without
 * this, they all share logical database 0 and — because several of them
 * FLUSHALL between tests — running on parallel workers clobbers each other's
 * state, failing unrelated assertions. Mirrors workerRedisUrl in env.ts so a
 * worker's Redis DB always matches the one the rest of its suite uses.
 *
 * Falls back to the base URL when VITEST_POOL_ID is absent (a bare `node`
 * run), where there is nothing to scope.
 */
export function workerScopedRedisUrl(baseUrl: string): string {
  const workerId = process.env.VITEST_POOL_ID;
  if (!workerId) return baseUrl;
  const url = new URL(baseUrl);
  url.pathname = `/${workerId}`;
  return url.toString();
}
