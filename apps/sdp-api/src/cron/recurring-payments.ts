import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import type { Env } from "@/types/env";
import { alwaysEnabled, defineCron } from "./define-cron";

/**
 * Collect the recurring payments due now in the open cluster scope.
 *
 * @param env - Process environment.
 * @returns Resolves once the due collections have run.
 */
async function collectDueNow(env: Env): Promise<void> {
  await collectDueRecurringPayments(env, new Date());
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
