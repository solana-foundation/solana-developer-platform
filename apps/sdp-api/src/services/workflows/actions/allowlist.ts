import type { WorkflowExecutionRow } from "@/db/repositories";
import { addAndSyncAllowlistEntry } from "@/services/allowlist-sync";
import type { Env } from "@/types/env";
import { humanizeWorkflowKey } from "../labels";
import { resolveParam, resolveTargetWallet } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

// The canonical action: add the target wallet to the token's allowlist. Follows the
// shared param convention (`params.wallet` overrides the trigger's subject wallet) so
// the action also works for triggers whose payload carries no wallet. Reuses the shared,
// idempotent allowlist-sync primitive (already-present → success), so a manual retry
// after a partial success converges.
export async function runAllowlistAdd(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const wallet = resolveTargetWallet(execution, action);
  if (!wallet) {
    // No wallet to act on — permanent, don't retry.
    return { status: "failed", retryable: false, result: {}, error: "MISSING_PARAM:wallet" };
  }

  const result = await addAndSyncAllowlistEntry({
    env,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
    tokenId: execution.token_id,
    walletAddress: wallet,
    label: resolveParam(action, "label") ?? `Auto: ${humanizeWorkflowKey(execution.trigger_type)}`,
    addedBy: `workflow:${execution.workflow_id}`,
  });

  if (result.status === "failed") {
    // A missing token is a config gap (permanent); RPC/chain errors are transient.
    const permanent = result.error === "TOKEN_NOT_FOUND";
    return {
      status: "failed",
      retryable: !permanent,
      result: { allowlist: result },
      error: result.error,
    };
  }

  return { status: "succeeded", retryable: false, result: { allowlist: result } };
}
