import { getDb } from "@/db";
import { AppError, conflict } from "@/lib/errors";
import { getPolicyGateContext } from "@/middleware/policy-gate";
import { getLogger } from "@/runtime/logger";
import { approvedWalletOperationId } from "@/services/policy/approved-operation-replay";
import type { AppContext } from "../context";

/**
 * Only for custody vault handlers that persist signed intent BEFORE broadcast.
 * A failed build may release its policy key; an ambiguous send may not. Never
 * use this for provider-managed program withdrawals or approval executors.
 */
export async function recoverFailedVaultPolicyExecution<T>(
  c: AppContext,
  execute: () => Promise<T>
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    const { enforcement } = getPolicyGateContext(c);
    if (enforcement?.evaluation.decision === "allow" && !approvedWalletOperationId(c)) {
      const operation = enforcement.operation;
      try {
        await getDb(c.env)
          .prepare(
            `UPDATE wallet_operations operation
             SET status = 'failed', idempotency_key = NULL,
                 execution_error = 'Vault execution failed before durable intent was recorded',
                 updated_at = sdp_iso_now()
             WHERE operation.id = ? AND operation.organization_id = ?
               AND operation.project_id IS NOT DISTINCT FROM ?
               AND operation.idempotency_key = ? AND operation.status = 'evaluated'
               AND operation.operation_type IN ('earn_vault_deposit', 'earn_vault_withdrawal')
               AND operation.execution_started_at IS NULL
               AND operation.execution_effect_started_at IS NULL
               AND NOT EXISTS (SELECT 1 FROM approval_requests
                 WHERE wallet_operation_id = operation.id)
               AND NOT EXISTS (SELECT 1 FROM earn_movements
                 WHERE organization_id = operation.organization_id
                   AND request_id = operation.idempotency_key)
               AND NOT EXISTS (SELECT 1 FROM earn_vault_withdrawal_requests
                 WHERE organization_id = operation.organization_id
                   AND client_request_id = operation.idempotency_key)`
          )
          .bind(
            operation.id,
            operation.organizationId,
            operation.projectId,
            operation.idempotencyKey
          )
          .run();
      } catch (recoveryError) {
        // Failure to prove absence retains the key. Do not mask the original error.
        getLogger().error(
          { err: recoveryError, walletOperationId: operation.id },
          "Earn policy recovery failed"
        );
      }
    }
    throw error;
  }
}

/**
 * Pre-execution policy replays, shared by every Earn money mover: a key that
 * already produced a wallet operation must answer with that operation's state
 * (still pending approval, executing, denied, canceled) rather than starting a
 * second one — and a key reused with a different payload is a conflict even
 * before any movement exists.
 *
 * The lookup scope must match the scope the movement ledger enforces for the
 * same key, or a retry can miss the operation it should be replaying and open a
 * second one. A vault movement is keyed per project, so it looks up per project.
 * A program withdrawal is keyed by organization and provider wallet — its
 * derived request id already names the operation type and the wallet — so it
 * looks across every project in the organization; scoping it per project would
 * let a sibling project mint a second approval for the same payout.
 */
export type EarnPolicyReplayScope =
  | { readonly kind: "project"; readonly projectId: string | null }
  | { readonly kind: "organization" };

export async function throwOnPriorEarnPolicyOperation(
  c: AppContext,
  params: {
    organizationId: string;
    scope: EarnPolicyReplayScope;
    idempotencyKey: string;
    idempotencyFingerprint: string;
    operationNoun: "vault deposit" | "vault withdrawal" | "program withdrawal";
  }
): Promise<void> {
  const projectPredicate =
    params.scope.kind === "project" ? "AND operation.project_id IS NOT DISTINCT FROM ?" : "";
  const projectBindings = params.scope.kind === "project" ? [params.scope.projectId] : [];
  const prior = await getDb(c.env)
    .prepare(
      `SELECT operation.id, operation.status, operation.raw_payload,
              evaluation.id AS policy_evaluation_id,
              evaluation.decision, evaluation.reason_code, evaluation.reason,
              evaluation.requires_approval, evaluation.approval_request_id
       FROM wallet_operations operation
       LEFT JOIN LATERAL (
         SELECT * FROM policy_evaluations
         WHERE wallet_operation_id = operation.id
         ORDER BY created_at DESC, id DESC
         LIMIT 1
       ) evaluation ON TRUE
       WHERE operation.organization_id = ?
         ${projectPredicate}
         AND operation.idempotency_key = ?
       ORDER BY operation.created_at DESC, operation.id DESC
       LIMIT 1`
    )
    .bind(params.organizationId, ...projectBindings, params.idempotencyKey)
    .first<{
      id: string;
      status: string;
      raw_payload: Record<string, unknown>;
      policy_evaluation_id: string | null;
      decision: string | null;
      reason_code: string | null;
      reason: string | null;
      requires_approval: boolean | null;
      approval_request_id: string | null;
    }>();
  if (!prior) return;
  if (prior.raw_payload.idempotencyFingerprint !== params.idempotencyFingerprint) {
    throw conflict("Idempotency key already used with different request payload");
  }

  const details = {
    walletOperationId: prior.id,
    policyEvaluationId: prior.policy_evaluation_id,
    decision: prior.decision,
    reasonCode: prior.reason_code,
    reason: prior.reason,
    requiresApproval: prior.requires_approval,
    approvalRequestId: prior.approval_request_id,
  };
  if (prior.status === "pending_approval" || prior.status === "executing") {
    throw new AppError(
      "SIGNING_PENDING",
      prior.status === "pending_approval"
        ? "Wallet operation requires policy approval"
        : `Approved ${params.operationNoun} execution is still in progress`,
      details
    );
  }
  if (prior.decision === "deny" || prior.status === "canceled") {
    throw new AppError("FORBIDDEN", "Wallet operation denied by policy", {
      ...details,
      intentOutcome: "denied",
      idempotencyKey: params.idempotencyKey,
    });
  }
  throw conflict(`The prior ${params.operationNoun} policy operation has no replayable movement`);
}
