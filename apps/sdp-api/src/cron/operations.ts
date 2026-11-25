import { reconcileOperations } from "@/services/jobs/reconcile-operations";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Recorded approvals and signed attempts outlive product admission switches. */
export const operationsCron = defineCron({
  name: "reconcile-operations",
  schedule: "*/2 * * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: reconcileOperations,
});
