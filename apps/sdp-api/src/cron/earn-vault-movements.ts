import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { reconcileEarnVaultMovements } from "@/services/jobs/reconcile-earn-vault-movements";
import type { Env } from "@/types/env";

export const EARN_VAULT_MOVEMENTS_MONITOR = "sdp-api-reconcile-earn-vault-movements";
export const EARN_VAULT_MOVEMENTS_CRON = "* * * * *";

export function runEarnVaultMovementsReconciliation(deps: {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}): void {
  const work = () => reconcileEarnVaultMovements(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(EARN_VAULT_MOVEMENTS_MONITOR, work, {
        schedule: { type: "crontab", value: EARN_VAULT_MOVEMENTS_CRON },
      })
    : Promise.resolve().then(work);
  deps.bg.run(promise);
}
