import { sweepRampTransferStatuses } from "@/services/jobs/sweep-ramp-transfer-statuses";
import { alwaysEnabled, defineCron } from "./define-cron";

// `global` on purpose: the sweep asks provider APIs, never the chain, and each
// row's project environment picks its credentials and its settlement guard.
/** Provider status pulls for ramp transfers whose webhooks may be lost, and expiry for abandoned checkouts. */
export const rampTransferStatusesCron = defineCron({
  name: "sweep-ramp-transfer-statuses",
  schedule: "*/5 * * * *",
  scope: "global",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: async (env) => {
    await sweepRampTransferStatuses(env);
  },
});
