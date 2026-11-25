import { currentClusterScope } from "@sdp/rpc/scope";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Recorded approvals and signed attempts outlive product admission switches. */
export const operationsCron = defineCron({
  name: "reconcile-operations",
  schedule: "*/2 * * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  wakeupOnly: true,
  run: async (_env, context) => {
    context.wakeOperations(currentClusterScope().environment);
  },
});
