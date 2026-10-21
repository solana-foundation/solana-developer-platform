import { getLogger } from "@/runtime/logger";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import type { Env } from "@/types/env";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Collect the recurring payments due now in the open cluster scope and log the tick's counts, so
 * a run that recovered, failed or skipped rows is visible beside the runner's `sdp_cron_run` line.
 *
 * @param env - Process environment.
 * @returns Resolves once the due collections have run.
 */
async function collectDueNow(env: Env): Promise<void> {
  const result = await collectDueRecurringPayments(env, new Date());
  getLogger().info(result, "collectDueRecurringPayments: tick finished");
}

/** Recurring payment collection: signs new collections, each admitted through `assertMoneyStartAdmitted`. */
export const recurringPaymentsCron = defineCron({
  name: "collect-recurring-payments",
  schedule: "*/5 * * * *",
  scope: "cluster",
  effect: "starts",
  enabled: alwaysEnabled,
  run: collectDueNow,
});
