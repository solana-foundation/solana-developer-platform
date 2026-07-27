import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";
import { runAllowlistAdd } from "./allowlist";
import type { ActionExecutionResult } from "./types";

export type { ActionExecutionResult } from "./types";

// Dispatch a claimed execution to its action handler. v1 wires the canonical
// allowlist_add flow plus the no-op `record` side-effect; other catalog actions are
// defined + capability-gated but not yet executable, so they fail permanently (no
// retry) with a clear reason rather than looping.
export async function dispatchWorkflowAction(
  env: Env,
  execution: WorkflowExecutionRow
): Promise<ActionExecutionResult> {
  switch (execution.action_type) {
    case "allowlist_add":
      return runAllowlistAdd(env, execution);
    case "record":
      return { status: "succeeded", retryable: false, result: { recorded: true } };
    default:
      return {
        status: "failed",
        retryable: false,
        result: {},
        error: `ACTION_NOT_IMPLEMENTED:${execution.action_type}`,
      };
  }
}
