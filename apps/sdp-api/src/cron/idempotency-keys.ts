import { pruneIdempotencyKeys } from "@/services/jobs/prune-idempotency-keys";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Idempotency-Key retention (HOO-1918). Hourly: rows are kept for 24 hours and every claim
 * already ignores an expired row, so pruning only reclaims space. Behind no flag, because every
 * module's keys expire.
 */
export const idempotencyKeyPruneCron = defineCron({
  name: "prune-idempotency-keys",
  schedule: "17 * * * *",
  scope: "global",
  effect: "observes",
  enabled: alwaysEnabled,
  run: async (env) => {
    await pruneIdempotencyKeys(env);
  },
});
