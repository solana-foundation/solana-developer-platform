import type {
  PolicyEvaluation,
  WalletOperationEnvelope,
  WalletOperationPolicyEvaluation,
} from "@sdp/types";
import { walletOperationStatusForDecision } from "./decisions";
import { evaluateWalletOperationPolicies } from "./evaluate";
import type {
  CreateApprovalRequestInput,
  CreateWalletOperationInput,
  PolicyEnforcementStore,
  RecordPolicyEvaluationInput,
} from "./ports";

export interface WalletOperationPolicyEnforcement {
  operation: WalletOperationEnvelope;
  evaluation: PolicyEvaluation;
}

/**
 * Record a wallet operation, evaluate it against its effective policies, and
 * persist the outcome: an approval request when the decision pauses execution,
 * the evaluation audit row, and the operation's status transition.
 *
 * Decisions are returned, not thrown — `evaluation.decision` tells the caller
 * whether the operation may proceed. On a persistence failure mid-flow the
 * already-written rows are compensated to `failed` before rethrowing.
 *
 * @param store - The persistence the flow writes through.
 * @param input - The operation to enforce.
 * @returns The recorded operation and its policy evaluation.
 */
export async function enforceWalletOperationPolicy(
  store: PolicyEnforcementStore,
  input: CreateWalletOperationInput
): Promise<WalletOperationPolicyEnforcement> {
  const operation = await store.createWalletOperation({
    ...input,
    status: input.status === undefined ? "created" : input.status,
  });

  let approvalRequestId: string | null = null;

  try {
    const policies = await store.loadEffectivePolicies(operation);
    const result = evaluateWalletOperationPolicies({
      operation,
      legs: input.legs,
      walletPolicy: policies.walletPolicy,
      apiKeyPolicy: policies.apiKeyPolicy,
    });
    const status = walletOperationStatusForDecision(result.decision);

    if (status === "pending_approval") {
      const approvalRequest = await store.createApprovalRequest(
        createApprovalRequestInput(operation, result)
      );
      if (approvalRequest.status !== "pending") {
        throw new Error("Wallet operation approval request is no longer pending");
      }
      approvalRequestId = approvalRequest.id;
    }

    const evaluation = await store.recordPolicyEvaluation({
      ...createPolicyEvaluationInput(result),
      approvalRequestId,
    });
    const updated = await store.updateWalletOperationStatus(operation.id, status);

    return {
      operation: { ...operation, status: updated.status, updatedAt: updated.updatedAt },
      evaluation,
    };
  } catch (error) {
    await compensateEnforcementFailure(store, operation, approvalRequestId, error);
    throw error;
  }
}

/**
 * Map an evaluation onto the audit-row input it persists as, minus the
 * approval-request linkage the enforcement flow adds.
 *
 * @param result - The evaluation to persist.
 * @returns The audit-row input.
 */
export function createPolicyEvaluationInput(
  result: WalletOperationPolicyEvaluation
): Omit<RecordPolicyEvaluationInput, "approvalRequestId"> {
  return {
    walletOperationId: result.operation.id,
    walletPolicyRevisionId: result.walletPolicyRevisionId,
    apiKeyPolicyRevisionId: result.apiKeyPolicyRevisionId,
    decision: result.decision,
    reasonCode: result.reasonCode,
    reason: result.reason,
    matchedRules: result.matchedRules,
    evaluationContext: result.evaluationContext,
    requiresApproval: result.requiresApproval,
  };
}

/**
 * Mark the rows written before a mid-flow failure as failed. A compensation
 * failure is aggregated with the original error rather than swallowed.
 *
 * @param store - The persistence the flow writes through.
 * @param operation - The operation whose rows are compensated.
 * @param approvalRequestId - The approval request written before the failure, if any.
 * @param error - The original enforcement failure.
 */
async function compensateEnforcementFailure(
  store: PolicyEnforcementStore,
  operation: WalletOperationEnvelope,
  approvalRequestId: string | null,
  error: unknown
): Promise<void> {
  try {
    if (approvalRequestId !== null) {
      await store.failApprovalRequest(operation, approvalRequestId);
    } else {
      await store.updateWalletOperationStatus(operation.id, "failed");
    }
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `Wallet operation policy enforcement failed (${errorMessage(error)}) and cleanup failed (${errorMessage(cleanupError)})`
    );
  }
}

function createApprovalRequestInput(
  operation: WalletOperationEnvelope,
  evaluation: WalletOperationPolicyEvaluation
): CreateApprovalRequestInput {
  return {
    organizationId: operation.organizationId,
    projectId: operation.projectId,
    walletOperationId: operation.id,
    approvalGroupId: getApprovalGroupId(evaluation),
    provider: stringValue(operation.providerExtensions.provider),
    providerReference: firstStringValue(
      operation.providerExtensions.providerReference,
      operation.providerExtensions.approvalId,
      operation.providerExtensions.approvalRequestId
    ),
    providerPayload: operation.providerExtensions,
    requestedBy: operation.actor === null ? null : stringValue(operation.actor.id),
  };
}

/**
 * The approval group of the first matched approval rule that names one.
 *
 * ponytail: first-match is order-dependent; deterministic group selection is
 * PRO-1607's authorization-model work.
 *
 * @param evaluation - The combined evaluation.
 * @returns The approval group id, or null when no matched rule names one.
 */
function getApprovalGroupId(evaluation: WalletOperationPolicyEvaluation): string | null {
  for (const matchedRule of evaluation.matchedRules) {
    if (matchedRule.rule.kind === "approval" && matchedRule.rule.approvalGroupId !== undefined) {
      return matchedRule.rule.approvalGroupId;
    }
  }
  return null;
}

/**
 * Narrow a provider-extension value to a non-empty string.
 *
 * @param value - The value to narrow.
 * @returns The string, or null when absent or empty.
 */
function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The first value that narrows to a non-empty string.
 *
 * @param values - Candidate values in priority order.
 * @returns The first non-empty string, or null.
 */
function firstStringValue(...values: unknown[]): string | null {
  for (const value of values) {
    const narrowed = stringValue(value);
    if (narrowed !== null) {
      return narrowed;
    }
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
