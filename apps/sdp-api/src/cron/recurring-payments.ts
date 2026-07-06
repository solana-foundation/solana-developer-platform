import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { collectDueRecurringPayments } from "@/services/jobs/collect-recurring-payments";
import type { Env } from "@/types/env";

export const RECURRING_PAYMENTS_COLLECTION_MONITOR = "sdp-api-collect-recurring-payments";
export const RECURRING_PAYMENTS_COLLECTION_CRON = "*/5 * * * *";

export interface RecurringPaymentsCollectionDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runRecurringPaymentsCollection(deps: RecurringPaymentsCollectionDeps): void {
  const work = () => collectDueRecurringPayments(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(RECURRING_PAYMENTS_COLLECTION_MONITOR, work, {
        schedule: { type: "crontab", value: RECURRING_PAYMENTS_COLLECTION_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
