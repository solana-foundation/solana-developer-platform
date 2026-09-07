import { getDb } from "@/db";
import { AppError, conflict } from "@/lib/errors";
import type { AppContext } from "../context";

/**
 * Pre-execution policy replays, shared by every Earn money mover: a key that
 * already produced a wallet operation must answer with that operation's state
 * (still pending approval, executing, denied, canceled) rather than starting a
 * second one — and a key reused with a different payload is a conflict even
 * before any movement exists.
 *
 * `projectId` is nullable because a program withdrawal is organization-scoped;
 * a null narrows the lookup to operations recorded without a project rather
 * than widening it across siblings.
 */
export async function throwOnPriorEarnPolicyOperation(
  c: AppContext,
  params: {
    organizationId: string;
    projectId: string | null;
    idempotencyKey: string;
    idempotencyFingerprint: string;
    operationNoun: "vault deposit" | "vault withdrawal" | "program withdrawal";
  }
): Promise<void> {
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
         AND operation.project_id IS NOT DISTINCT FROM ?
         AND operation.idempotency_key = ?`
    )
    .bind(params.organizationId, params.projectId, params.idempotencyKey)
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
    throw new AppError("FORBIDDEN", "Wallet operation denied by policy", details);
  }
  throw conflict(`The prior ${params.operationNoun} policy operation has no replayable movement`);
}
