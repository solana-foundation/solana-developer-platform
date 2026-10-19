import { reconcileRevokedApiKeyCache } from "@/services/jobs/reconcile-revoked-api-key-cache";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Repairs cache entries that still authenticate a key Postgres has already revoked: the residue
 * of a revocation whose post-commit cache write failed. A security recovery path, not a
 * feature, so it is always on.
 */
export const revokedApiKeyCacheCron = defineCron({
  name: "reconcile-revoked-api-key-cache",
  schedule: "* * * * *",
  scope: "global",
  effect: "observes",
  enabled: alwaysEnabled,
  run: async (env) => {
    await reconcileRevokedApiKeyCache(env);
  },
});
