import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { reconcileDvpTrades } from "@/services/jobs/reconcile-dvp-trades";
import type { Env } from "@/types/env";

export const DVP_TRADES_MONITOR = "sdp-api-reconcile-dvp-trades";
export const DVP_TRADES_CRON = "* * * * *";

export function runDvpTradeReconciliation(deps: {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}): void {
  const work = () => reconcileDvpTrades(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(DVP_TRADES_MONITOR, work, {
        schedule: { type: "crontab", value: DVP_TRADES_CRON },
      })
    : Promise.resolve().then(work);
  deps.bg.run(promise);
}
