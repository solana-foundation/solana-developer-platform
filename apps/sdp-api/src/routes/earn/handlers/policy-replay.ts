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
    operationNoun:
      | "vault deposit"
      | "vault withdrawal"
      | "program withdrawal"
      | "program retarget";
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
    throw new AppError("FORBIDDEN", "Wallet operation denied by policy", details);
  }
  throw conflict(`The prior ${params.operationNoun} policy operation has no replayable movement`);
}
