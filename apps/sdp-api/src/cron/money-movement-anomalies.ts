import { detectMoneyMovementAnomalies } from "@/services/jobs/detect-money-movement-anomalies";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Money movement anomalies (HOO-2346): hourly, a few minutes past the hour so
 * the hour it checks has ended, once per Environment. Reads only.
 */
export const moneyMovementAnomaliesCron = defineCron({
  name: "detect-money-movement-anomalies",
  schedule: "5 * * * *",
  scope: "cluster",
  effect: "observes",
  enabled: alwaysEnabled,
  run: async (env) => {
    await detectMoneyMovementAnomalies(env);
  },
});
