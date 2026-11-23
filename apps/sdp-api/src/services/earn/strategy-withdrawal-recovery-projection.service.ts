import {
  isTerminalOperationStatus,
  type Operation,
  type OperationSource,
  projectedOperationStatus,
} from "@sdp/types/operations";
import { getDb } from "@/db/client";
import type {
  EarnVaultWithdrawalRequestActionRow,
  EarnVaultWithdrawalRequestRow,
} from "@/db/repositories/earn-vault-withdrawal-requests.repository";
import type { OperationScope } from "@/db/repositories/operations.repository";
import { notFound } from "@/lib/errors";
import type { Env } from "@/types/env";

interface RecoveryRow {
  action_status: EarnVaultWithdrawalRequestActionRow["status"];
  signature: string;
  failure_reason: string | null;
  request_status: EarnVaultWithdrawalRequestRow["status"];
  cancel_signature: string | null;
  closing_signature: string | null;
  position_id: string;
  strategy_id: string | null;
  source: OperationSource;
  custody_wallet_id: string | null;
  owner_address: string;
  share_mint: string;
  shares: string;
}

/** Recovery completes from its exact finalized action, never an expected payout. */
export async function projectWithdrawalRecovery(
  env: Env,
  scope: OperationScope,
  operation: Operation,
  actionId: string
): Promise<Operation> {
  const row = await getDb(env).queryOne<RecoveryRow>(
    `SELECT action.status AS action_status, action.signature, action.failure_reason,
            request.status AS request_status, request.cancel_signature, request.closing_signature,
            request.position_id, request.custody_wallet_id, request.owner_address,
            request.share_mint, request.shares, position.strategy_id, operation.source
       FROM earn_vault_withdrawal_request_actions action
       JOIN earn_vault_withdrawal_requests request
         ON request.id = action.withdrawal_request_id
        AND request.organization_id = action.organization_id
        AND request.project_id = action.project_id AND request.environment = action.environment
       JOIN earn_positions position ON position.id = request.position_id
        AND position.organization_id = request.organization_id
        AND position.project_id = request.project_id AND position.environment = request.environment
       JOIN operation_attempts attempt ON attempt.id = action.client_request_id
        AND attempt.organization_id = action.organization_id
        AND attempt.project_id = action.project_id AND attempt.environment = action.environment
       JOIN operations operation ON operation.id = attempt.operation_id
        AND operation.organization_id = attempt.organization_id
        AND operation.project_id = attempt.project_id AND operation.environment = attempt.environment
       JOIN earn_wallet_withdrawal_request_transactions build
         ON build.id = attempt.build_ref ->> 'id' AND build.consumed_action_id = action.id
        AND build.organization_id = action.organization_id
        AND build.project_id = action.project_id AND build.environment = action.environment
      WHERE action.id = ? AND action.action = 'cancel' AND operation.id = ?
        AND operation.action_id = attempt.action_id AND operation.action_version = attempt.action_version
        AND action.organization_id = ? AND action.project_id = ? AND action.environment = ?`,
    [actionId, operation.id, scope.organizationId, scope.projectId, scope.environment]
  );
  if (
    row === null ||
    ("walletId" in row.source
      ? row.source.walletId !== row.custody_wallet_id
      : row.custody_wallet_id !== null || row.source.ownerAddress !== row.owner_address)
  )
    throw notFound("Operation withdrawal recovery");
  const recovered =
    row.action_status === "finalized" &&
    row.request_status === "cancelled" &&
    row.closing_signature === row.signature &&
    row.cancel_signature === row.signature;
  const failed =
    row.action_status === "failed" ||
    row.request_status === "fulfilled" ||
    (row.request_status === "cancelled" &&
      row.closing_signature !== null &&
      row.closing_signature !== row.signature);
  // A terminal operation keeps its status and error: later evidence cannot reopen or flip it.
  const terminal = isTerminalOperationStatus(operation.status);
  const status = projectedOperationStatus(
    operation.status,
    recovered ? "completed" : failed ? "failed" : "settling"
  );
  const returned = recovered && status === "completed";
  return {
    ...operation,
    status,
    nextAction:
      status === "settling"
        ? { type: "wait", reason: "Waiting for verified return of escrowed shares" }
        : null,
    error: terminal
      ? operation.error
      : failed
        ? {
            code: "TRANSACTION_FAILED",
            message: row.failure_reason ?? "This recovery did not return the escrowed shares",
          }
        : null,
    result: {
      positionId: row.position_id,
      ...(row.strategy_id === null ? {} : { strategyId: row.strategy_id }),
      source: row.source,
      signature: row.signature,
      settledAmount: returned ? { mint: row.share_mint, value: row.shares } : null,
      settlementOutcome: returned ? "recovered" : null,
    },
  };
}
