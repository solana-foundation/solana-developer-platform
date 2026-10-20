import { retireOrphanedSecrets } from "@/services/jobs/retire-orphaned-secrets";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Orphaned secret retirement. Every five minutes rather than every minute: the queue is empty
 * unless a destroy failed, and a queued row's own backoff starts at five minutes. Behind no
 * flag: the queue holds credentials already orphaned, so cleanup outlives whichever feature
 * queued them.
 */
export const secretRetirementsCron = defineCron({
  name: "retire-secrets",
  schedule: "*/5 * * * *",
  scope: "global",
  effect: "observes",
  enabled: alwaysEnabled,
  run: async (env) => {
    await retireOrphanedSecrets(env);
  },
});
