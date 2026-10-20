import { verifyRampDeliveries } from "@/services/jobs/verify-ramp-deliveries";
import { alwaysEnabled, defineCron } from "./define-cron";

/** Chain verification for provider-settled ramp transfers. */
export const rampDeliveriesCron = defineCron({
  name: "verify-ramp-deliveries",
  schedule: "* * * * *",
  scope: "cluster",
  effect: "finishes",
  enabled: alwaysEnabled,
  run: verifyRampDeliveries,
});
