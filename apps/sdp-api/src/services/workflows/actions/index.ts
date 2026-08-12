import type { WorkflowExecutionRow } from "@/db/repositories";
import type { Env } from "@/types/env";
import { runAllowlistAdd } from "./allowlist";
import { runAllowlistRemove } from "./allowlist-remove";
import { runFreeze, runPause, runUnfreeze, runUnpause } from "./lifecycle";
import { runNotify } from "./notify";
import { runBurn, runForceBurn, runMint, runSeize } from "./supply";
import type { ActionContext, ActionExecutionResult } from "./types";
import { runSendWebhook } from "./webhook";

export type { ActionContext, ActionExecutionResult } from "./types";

// Dispatch a claimed execution to its action handler. The rule's static action params
// (amount / destination / target wallet / webhook url / notify audience) are resolved by
// the cron engine and threaded in via `ctx`. Actions still not wired fail permanently
// (no retry) with a clear reason rather than looping.
export async function dispatchWorkflowAction(
  env: Env,
  execution: WorkflowExecutionRow,
  ctx: ActionContext
): Promise<ActionExecutionResult> {
  switch (execution.action_type) {
    case "allowlist_add":
      return runAllowlistAdd(env, execution, ctx);
    case "allowlist_remove":
      return runAllowlistRemove(env, execution, ctx);
    case "pause":
      return runPause(env, execution, ctx);
    case "unpause":
      return runUnpause(env, execution, ctx);
    case "freeze":
      return runFreeze(env, execution, ctx);
    case "unfreeze":
      return runUnfreeze(env, execution, ctx);
    case "mint":
      return runMint(env, execution, ctx);
    case "burn":
      return runBurn(env, execution, ctx);
    case "force_burn":
      return runForceBurn(env, execution, ctx);
    case "seize":
      return runSeize(env, execution, ctx);
    case "send_webhook":
      return runSendWebhook(env, execution, ctx);
    case "notify":
      return runNotify(env, execution, ctx);
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
