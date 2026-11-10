import { pruneAccountPii } from "@/services/jobs/prune-account-pii";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Proposed age-based cleanup reports candidates until its policy is approved. */
export const accountPiiCron = defineCron({
  name: "prune-account-pii",
  schedule: "37 * * * *",
  scope: "global",
  effect: "observes",
  enabled: alwaysEnabled,
  run: async (env) => {
    await pruneAccountPii(env);
  },
});
