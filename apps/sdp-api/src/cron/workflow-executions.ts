import type { BackgroundRunner } from "@/runtime/background";
import type { Observability } from "@/runtime/observability";
import { runDueWorkflowExecutions } from "@/services/jobs/run-workflow-executions";
import type { Env } from "@/types/env";

export const WORKFLOW_EXECUTIONS_MONITOR = "sdp-api-run-workflow-executions";
export const WORKFLOW_EXECUTIONS_CRON = "* * * * *";

export interface WorkflowExecutionsDeps {
  env: Env;
  bg: BackgroundRunner;
  observability?: Observability;
}

export function runWorkflowExecutions(deps: WorkflowExecutionsDeps): void {
  const work = () => runDueWorkflowExecutions(deps.env);
  const promise = deps.observability
    ? deps.observability.withMonitor(WORKFLOW_EXECUTIONS_MONITOR, work, {
        schedule: { type: "crontab", value: WORKFLOW_EXECUTIONS_CRON },
      })
    : Promise.resolve().then(work);

  deps.bg.run(promise);
}
