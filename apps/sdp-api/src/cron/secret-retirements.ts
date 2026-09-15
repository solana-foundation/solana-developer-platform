import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { retireOrphanedSecrets } from "@/services/jobs/retire-orphaned-secrets";
import type { Env } from "@/types/env";

export const SECRET_RETIREMENTS_MONITOR = "sdp-api-retire-secrets";
// Every five minutes rather than every minute: the queue is empty unless a destroy
// failed, and a queued row's own backoff starts at five minutes, so a tighter schedule
// would only re-read an empty table.
export const SECRET_RETIREMENTS_CRON = "*/5 * * * *";

export interface SecretRetirementsDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runSecretRetirements(deps: SecretRetirementsDeps): void {
  const work = () => retireOrphanedSecrets(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(SECRET_RETIREMENTS_MONITOR, work, {
        schedule: { type: "crontab", value: SECRET_RETIREMENTS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
