import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { retireOrphanedActionSecrets } from "@/services/jobs/retire-workflow-secrets";
import type { Env } from "@/types/env";

export const WORKFLOW_SECRET_RETIREMENTS_MONITOR = "sdp-api-retire-workflow-secrets";
// Every five minutes rather than every minute: the queue is empty unless a destroy
// failed, and a queued row's own backoff starts at five minutes, so a tighter schedule
// would only re-read an empty table.
export const WORKFLOW_SECRET_RETIREMENTS_CRON = "*/5 * * * *";

export interface WorkflowSecretRetirementsDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runWorkflowSecretRetirements(deps: WorkflowSecretRetirementsDeps): void {
  const work = () => retireOrphanedActionSecrets(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(WORKFLOW_SECRET_RETIREMENTS_MONITOR, work, {
        schedule: { type: "crontab", value: WORKFLOW_SECRET_RETIREMENTS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
