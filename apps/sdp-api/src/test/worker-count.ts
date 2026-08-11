import os from "node:os";

/**
 * Number of parallel vitest workers, shared by vitest.config.ts (maxWorkers)
 * and node-global-setup.ts (per-worker database provisioning) so the two can
 * never drift. Capped at 15 because each worker claims the Redis logical
 * database matching its VITEST_POOL_ID and stock Redis ships 16 (0-15).
 */
export const TEST_WORKER_COUNT = Math.min(os.availableParallelism(), 15);
