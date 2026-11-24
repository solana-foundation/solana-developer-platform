import type { OperationSource } from "@sdp/types/operations";
import { getDb } from "@/db/client";
import { isCurrentRedemptionReleaseBuild } from "@/db/repositories/earn-redemption-release.repository";
import type { OperationClaim, OperationScope } from "@/db/repositories/operations.repository";
import { conflict, notFound } from "@/lib/errors";
import type { Env } from "@/types/env";
import {
  requirePreparedQueuedStrategyTransaction,
  submitPreparedQueuedStrategyAction,
} from "./strategy-queued-operations.service";
import { submitCurrentRedemptionRelease } from "./strategy-redemption-release.service";
import {
  type PreparedStrategySigningTarget,
  requirePreparedStrategyTransaction,
  type StrategyTransactionScope,
  submitPreparedStrategyTransaction,
} from "./strategy-transactions.service";

/** Resolve the exact stored build for every transaction step through one seam. */
export async function resolveEarnOperationBuild(
  env: Env,
  scope: OperationScope,
  claim: OperationClaim
) {
  const reference = claim.attempt.buildRef;
  const queued = reference?.kind === "earn.queued_transaction";
  if (reference?.kind !== "earn.strategy_transaction" && !queued)
    throw conflict("Operation has no prepared transaction to submit");
  const table = queued ? "earn_wallet_withdrawal_request_transactions" : "earn_wallet_transactions";
  const source = await getDb(env).queryOne<{
    custody_wallet_id: string | null;
    owner_address: string;
    source: OperationSource;
  }>(
    `SELECT prepared.custody_wallet_id, prepared.owner_address, operation.source
     FROM ${table} prepared JOIN operations operation
       ON operation.id = ? AND operation.organization_id = prepared.organization_id
       AND operation.project_id = prepared.project_id AND operation.environment = prepared.environment
     WHERE prepared.id = ? AND prepared.organization_id = ? AND prepared.project_id = ? AND prepared.environment = ?`,
    [claim.operation.id, reference.id, scope.organizationId, scope.projectId, scope.environment]
  );
  if (source === null) throw notFound("Prepared strategy transaction");
  if (
    "walletId" in source.source
      ? source.source.walletId !== source.custody_wallet_id
      : source.custody_wallet_id !== null || source.source.ownerAddress !== source.owner_address
  ) {
    throw conflict("Prepared transaction does not match the operation source");
  }
  const transactionScope: StrategyTransactionScope = {
    ...scope,
    custodyWalletId: source.custody_wallet_id,
  };
  if (queued) {
    const row = await requirePreparedQueuedStrategyTransaction(env, transactionScope, reference.id);
    const currentRelease = isCurrentRedemptionReleaseBuild(row);
    const reviewedRecovery = currentRelease
      ? claim.operation.terms.options.length === 1 &&
        claim.operation.terms.options[0]?.id === "release_current_redemption" &&
        claim.operation.terms.options[0]?.mechanism === "release_current_redemption" &&
        claim.operation.terms.inputAmount === null &&
        claim.operation.terms.estimate === null &&
        claim.operation.terms.minimum === null
      : row.mechanism === "solver_queue" &&
        row.withdrawal_request_id !== null &&
        claim.operation.terms.options.some(
          (option) =>
            option.id === `recover_expired_escrow:${row.withdrawal_request_id}` &&
            option.mechanism === "recover_expired_escrow"
        );
    if (
      claim.operation.intent.kind !== "earn.withdraw" ||
      (row.action === "cancel" &&
        (claim.operation.intent.amount.kind !== "all" ||
          row.position_id !== claim.operation.intent.positionId ||
          !reviewedRecovery))
    )
      throw conflict("Prepared transaction does not match the operation action");
    const target: PreparedStrategySigningTarget = {
      ...row,
      fee_mode: row.fee_mode ?? "wallet",
      movement:
        row.action === "cancel" ? "earn.queued_withdraw_cancel" : "earn.queued_withdraw_request",
    };
    return {
      target,
      transactionScope,
      currentRelease,
      submit: async (signedTransaction: string, broadcast: boolean) => {
        if (currentRelease)
          return submitCurrentRedemptionRelease(env, {
            scope,
            buildId: row.id,
            attemptId: claim.attempt.id,
            signedTransaction,
            broadcast,
          });
        const principal = claim.attempt.principal;
        const submitted = await submitPreparedQueuedStrategyAction(env, {
          transactionId: row.id,
          signedTransaction,
          custodyWalletId: transactionScope.custodyWalletId,
          clientRequestId: claim.attempt.id,
          broadcast,
          actor: {
            ...scope,
            userId: principal.kind === "member" ? principal.userId : null,
            apiKeyId: principal.kind === "api_key" ? principal.apiKeyId : null,
          },
        });
        return submitted.resourceRef;
      },
    };
  }
  const row = await requirePreparedStrategyTransaction(env, transactionScope, reference.id);
  if ((row.direction === "deposit") !== (claim.operation.intent.kind === "earn.deposit")) {
    throw conflict("Prepared transaction does not match the operation action");
  }
  if (claim.operation.intent.kind === "earn.deposit") {
    if (row.strategy_id !== claim.operation.intent.strategyId)
      throw conflict("Prepared transaction does not match the operation strategy");
  }
  const target: PreparedStrategySigningTarget = {
    ...row,
    movement: row.direction === "deposit" ? "earn.deposit" : "earn.withdraw",
  };
  return {
    target,
    transactionScope,
    currentRelease: false,
    submit: async (signedTransaction: string, broadcast: boolean) => {
      const principal = claim.attempt.principal;
      const submitted = await submitPreparedStrategyTransaction(env, {
        ...transactionScope,
        transactionId: row.id,
        signedTransaction,
        requestId: claim.attempt.id,
        broadcast,
        userId: principal.kind === "member" ? principal.userId : null,
        apiKeyId: principal.kind === "api_key" ? principal.apiKeyId : null,
      });
      return { kind: "earn.movement", id: submitted.movement.id };
    },
  };
}
