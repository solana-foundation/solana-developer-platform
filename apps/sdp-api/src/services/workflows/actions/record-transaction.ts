// Ledger entry for a workflow-driven on-chain operation.
//
// Every manual issuance op goes through tokenService.createTransaction and then
// updateTransaction({status:"confirmed"}), which is what makes it visible in the
// Transactions and Activity tabs and in GET /tokens/:id/transactions. Workflow actions
// called the mosaic primitives directly, so a rule-driven mint or seize left nothing
// there — only an audit row with the system actor. Same operation, invisible in the
// place operators go to look at operations.

import type { TokenTransactionType } from "@sdp/types";
import { getDb } from "@/db";
import type { WorkflowExecutionRow } from "@/db/repositories";
import { getLogger } from "@/runtime/logger";
import { TokenService } from "@/services/token.service";
import type { Env } from "@/types/env";
import { errorMessage } from "./onchain";

// Best-effort: the chain effect has already landed by the time this runs, so a ledger
// write failure must never fail (or re-run) the action. Surfaced as `ledgerFailed`.
export async function recordWorkflowTransaction(
  env: Env,
  execution: WorkflowExecutionRow,
  input: {
    type: TokenTransactionType;
    params: Record<string, unknown>;
    signature: string;
    slot?: string | number | bigint | null;
  }
): Promise<boolean> {
  try {
    const tokenService = new TokenService(getDb(env));
    const { transaction } = await tokenService.createTransaction({
      tokenId: execution.token_id,
      organizationId: execution.organization_id,
      type: input.type,
      params: {
        ...input.params,
        // Names the rule that caused this, so the Transactions tab can say "automation"
        // rather than attributing it to whoever last touched the asset.
        workflowId: execution.workflow_id,
        workflowExecutionId: execution.id,
        triggerType: execution.trigger_type,
      },
      // The execution id is already unique per (rule, trigger event), so a re-run after
      // a crash reuses the same ledger row instead of creating a second one.
      idempotencyKey: `workflow:${execution.id}`,
      idempotencyFingerprint: `${input.type}:${input.signature}`,
    });
    await tokenService.updateTransaction(transaction.id, {
      status: "confirmed",
      signature: input.signature,
      ...(input.slot == null ? {} : { slot: Number(input.slot) }),
    });
    return true;
  } catch (error) {
    getLogger().error(
      { executionId: execution.id, type: input.type, error: errorMessage(error) },
      "workflow: transaction ledger write failed"
    );
    return false;
  }
}
