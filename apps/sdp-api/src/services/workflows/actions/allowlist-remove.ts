import type { WorkflowExecutionRow } from "@/db/repositories";
import { removeAndSyncAllowlistEntry } from "@/services/allowlist-sync";
import type { Env } from "@/types/env";
import { permanentFail, resolveTargetWallet, succeeded } from "./onchain";
import type { ActionContext, ActionExecutionResult } from "./types";

// Remove the target wallet from the token's allowlist. Reuses the shared, idempotent
// remove-and-sync primitive (already-absent → success) so a manual retry converges.
export async function runAllowlistRemove(
  env: Env,
  execution: WorkflowExecutionRow,
  action: ActionContext
): Promise<ActionExecutionResult> {
  const wallet = resolveTargetWallet(execution, action);
  if (!wallet) {
    return permanentFail("MISSING_PARAM:wallet");
  }

  const result = await removeAndSyncAllowlistEntry({
    env,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
    tokenId: execution.token_id,
    walletAddress: wallet,
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

  return succeeded({ allowlist: result });
}
