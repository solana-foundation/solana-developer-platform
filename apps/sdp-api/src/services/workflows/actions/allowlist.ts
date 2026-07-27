import type { WorkflowExecutionRow } from "@/db/repositories";
import { addAndSyncAllowlistEntry } from "@/services/allowlist-sync";
import type { Env } from "@/types/env";
import type { ActionExecutionResult } from "./types";

// The canonical action: add the trigger's wallet to the token's allowlist. Reuses the
// shared, idempotent allowlist-sync primitive (already-present → success), so a manual
// retry after a partial success converges.
export async function runAllowlistAdd(
  env: Env,
  execution: WorkflowExecutionRow
): Promise<ActionExecutionResult> {
  const wallet =
    typeof execution.trigger_payload.wallet === "string" ? execution.trigger_payload.wallet : null;
  if (!wallet) {
    // No wallet to act on — permanent, don't retry.
    return { status: "failed", retryable: false, result: {}, error: "MISSING_WALLET_IN_PAYLOAD" };
  }

  const result = await addAndSyncAllowlistEntry({
    env,
    organizationId: execution.organization_id,
    projectId: execution.project_id,
    tokenId: execution.token_id,
    walletAddress: wallet,
    label: "Auto: KYC approved",
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
