import { getDb } from "@/db/client";
import type { OperationRecord } from "@/db/repositories/operations.repository";
import { conflict } from "@/lib/errors";
import type { AppContext } from "@/routes/earn/context";
import {
  requirePreparedSwapStrategyTransaction,
  swapStrategyContinuation,
} from "@/services/earn/strategy-swap-operations.service";
import type { AuthorizedEarnPreparation } from "./prepare";

/** Keep every later review bound to the finalized prerequisite swap quantity. */
export async function authorizeEarnDepositRefresh(
  c: AppContext,
  record: OperationRecord,
  preparation: AuthorizedEarnPreparation
): Promise<AuthorizedEarnPreparation> {
  if (preparation.intent.kind !== "earn.deposit") return preparation;
  const attempt = await getDb(c.env).queryOne<{ advisory_id: string }>(
    `SELECT attempt.resource_ref ->> 'id' AS advisory_id FROM operation_attempts attempt
     LEFT JOIN earn_split_swap_advisories swap ON swap.id = attempt.resource_ref ->> 'id'
       AND swap.organization_id = attempt.organization_id AND swap.project_id = attempt.project_id
       AND swap.environment = attempt.environment
     WHERE attempt.operation_id = ? AND attempt.organization_id = ? AND attempt.project_id = ?
       AND attempt.environment = ? AND attempt.resource_ref ->> 'kind' = 'earn.swap'
     ORDER BY CASE WHEN swap.swap_chain_status = 'finalized' THEN 0 ELSE 1 END,
       attempt.action_version DESC, attempt.created_at DESC, attempt.id DESC LIMIT 1`,
    [
      record.operation.id,
      record.scope.organizationId,
      record.scope.projectId,
      record.scope.environment,
    ]
  );
  if (attempt === null) return preparation;
  const swap = await requirePreparedSwapStrategyTransaction(
    c.env,
    {
      ...record.scope,
      custodyWalletId: "walletId" in record.source ? record.source.walletId : null,
    },
    attempt.advisory_id
  );
  const continuation = swapStrategyContinuation(swap);
  const sameSource =
    "walletId" in record.source
      ? "walletId" in continuation.source && continuation.source.walletId === record.source.walletId
      : "ownerAddress" in continuation.source &&
        continuation.source.ownerAddress === record.source.ownerAddress;
  if (continuation.strategyId !== preparation.intent.strategyId || !sameSource) {
    throw conflict("The retained swap does not belong to this strategy source");
  }
  if (swap.swap_chain_status === "failed") return preparation;
  if (swap.swap_chain_status !== "finalized") {
    throw conflict("The prerequisite swap must finalize before refreshing the deposit");
  }
  // This is the accepted minimum for a new review, not an invented payout or a
  // read of the wallet's unrelated balance. The original funding intent stays.
  return {
    ...preparation,
    intent: {
      ...preparation.intent,
      amount: {
        mint: continuation.depositTokenMint,
        value: continuation.minOutAmount,
      },
    },
  };
}
