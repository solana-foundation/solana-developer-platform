import type {
  PolicyDecision,
  PolicyEvaluation,
  WalletOperationActor,
  WalletOperationEnvelope,
  WalletOperationPolicyEvaluation,
  WalletOperationStatus,
} from "@sdp/types";
import { getDb } from "@/db";
import {
  type ApprovalRequestRow,
  type CreateApprovalRequestInput,
  type CreateWalletOperationInput,
  createPolicyRepository,
  type PolicyRepository,
} from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, conflict, internalError } from "@/lib/errors";
import {
  CustodyConfigStore,
  type CustodyWalletLookup,
} from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { createPolicyEvaluationInput } from "./policy-evaluation.service";
import { PolicyFoundationService } from "./policy-foundation.service";

export interface WalletOperationPolicyEnforcement {
  operation: WalletOperationEnvelope;
  evaluation: PolicyEvaluation;
}

export class WalletPolicyEnforcementService {
  private readonly foundation: PolicyFoundationService;

  constructor(private readonly repository: PolicyRepository) {
    this.foundation = new PolicyFoundationService(repository);
  }

  async enforce(input: CreateWalletOperationInput): Promise<WalletOperationPolicyEnforcement> {
    const operation = await this.foundation.recordWalletOperation({
      ...input,
      status: input.status ?? "created",
    });

    let approvalRequestId: string | null = null;

    const { result, evaluation, updatedOperation } = await (async () => {
      try {
        const result = await this.foundation.evaluateWalletOperationPolicies(operation);
        const status = walletOperationStatusForDecision(result.decision);
        if (status === "pending_approval") {
          const approvalRequest = await this.repository.createApprovalRequest(
            createApprovalRequestInput(operation, result)
          );

          if (!approvalRequest) {
            throw internalError("Failed to create wallet operation approval request");
          }

          if (approvalRequest.status !== "pending") {
            throw internalError("Wallet operation approval request is no longer pending");
          }

          approvalRequestId = approvalRequest.id;
        }

        const evaluation = await this.foundation.recordPolicyEvaluation({
          ...createPolicyEvaluationInput(result),
          approvalRequestId,
        });
        const updated = await this.repository.updateWalletOperationStatus(operation.id, status);

        if (!updated) {
          throw internalError("Failed to update wallet operation policy status");
        }

        return {
          result,
          evaluation,
          updatedOperation: {
            ...operation,
            status: updated.status,
            updatedAt: updated.updated_at,
          },
        };
      } catch (error) {
        if (approvalRequestId) {
          try {
            await markApprovalRequestAndWalletOperationFailed(
              this.repository,
              operation.organizationId,
              approvalRequestId
            );
          } catch (cleanupError) {
            throw combineEnforcementAndCleanupErrors(error, cleanupError);
          }
        } else {
          await markWalletOperationFailed(this.repository, operation.id);
        }
        throw error;
      }
    })();

    if (result.decision === "allow") {
      return {
        operation: updatedOperation,
        evaluation,
      };
    }

    throw walletOperationPolicyDecisionError(updatedOperation, evaluation);
  }

  async approveApprovalRequest(
    organizationId: string,
    approvalRequestId: string,
    resolvedBy?: string | null
  ) {
    const approvalRequest = await this.repository.updateApprovalRequestStatus({
      organizationId,
      approvalRequestId,
      status: "approved",
      operationStatus: "executing",
      resolvedBy,
    });

    return requireApprovalRequestStatus(approvalRequest, "approved");
  }

  async cancelApprovalRequest(
    organizationId: string,
    approvalRequestId: string,
    resolvedBy?: string | null
  ) {
    const approvalRequest = await this.repository.updateApprovalRequestStatus({
      organizationId,
      approvalRequestId,
      status: "canceled",
      operationStatus: "canceled",
      resolvedBy,
    });

    return requireApprovalRequestStatus(approvalRequest, "canceled");
  }
}

export async function recordLegacyWalletPolicyDenial(
  env: Env,
  enforcement: WalletOperationPolicyEnforcement,
  error: unknown
): Promise<void> {
  const repository = createPolicyRepository(env);
  const reason =
    error instanceof Error && error.message
      ? error.message
      : "Legacy wallet policy denied wallet operation";

  try {
    if (enforcement.evaluation.evaluationContext) {
      await repository.createPolicyEvaluation({
        walletOperationId: enforcement.operation.id,
        walletPolicyRevisionId: null,
        apiKeyPolicyRevisionId: null,
        decision: "deny",
        reasonCode: "legacy_wallet_policy_denied",
        reason,
        matchedRules: [],
        evaluationContext: enforcement.evaluation.evaluationContext,
        requiresApproval: false,
      });
    }

    await repository.updateWalletOperationStatus(enforcement.operation.id, "failed");
  } catch (auditError) {
    console.error("Failed to record legacy wallet policy denial", {
      walletOperationId: enforcement.operation.id,
      error: auditError instanceof Error ? auditError.message : String(auditError),
    });
  }
}

async function markWalletOperationFailed(
  repository: PolicyRepository,
  walletOperationId: string
): Promise<void> {
  try {
    await repository.updateWalletOperationStatus(walletOperationId, "failed");
  } catch (error) {
    console.error("Failed to mark wallet operation failed", {
      walletOperationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function markApprovalRequestAndWalletOperationFailed(
  repository: PolicyRepository,
  organizationId: string,
  approvalRequestId: string
): Promise<void> {
  await repository.updateApprovalRequestStatus({
    organizationId,
    approvalRequestId,
    status: "failed",
    operationStatus: "failed",
  });
}

function requireApprovalRequestStatus<TStatus extends ApprovalRequestRow["status"]>(
  approvalRequest: ApprovalRequestRow | null,
  status: TStatus
): (ApprovalRequestRow & { status: TStatus }) | null {
  if (approvalRequest && approvalRequest.status !== status) {
    throw conflict(`Approval request is already ${approvalRequest.status}`);
  }

  return approvalRequest as (ApprovalRequestRow & { status: TStatus }) | null;
}

function combineEnforcementAndCleanupErrors(error: unknown, cleanupError: unknown): AggregateError {
  return new AggregateError(
    [error, cleanupError],
    `Wallet operation policy enforcement failed (${errorMessage(error)}) and approval cleanup failed (${errorMessage(cleanupError)})`
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function enforceWalletOperationPolicy(
  env: Env,
  input: CreateWalletOperationInput
): Promise<WalletOperationPolicyEnforcement> {
  const service = new WalletPolicyEnforcementService(createPolicyRepository(env));
  return service.enforce(input);
}

export function walletOperationActorFromAuth(auth: ApiKeyContext): WalletOperationActor | null {
  if (auth.apiKeyId) {
    return {
      type: "api_key",
      id: auth.apiKeyId,
      apiKeyId: auth.apiKeyId,
    };
  }

  if (auth.userId) {
    return {
      type: auth.authType,
      id: auth.userId,
      userId: auth.userId,
    };
  }

  return {
    type: auth.authType,
    id: auth.id,
  };
}

export async function resolvePolicyCustodyWallet(
  env: Env,
  auth: ApiKeyContext,
  walletId: string
): Promise<CustodyWalletLookup | null> {
  const store = new CustodyConfigStore(getDb(env), env.CUSTODY_ENCRYPTION_KEY);
  return store.findActiveWalletByIdentifier(
    auth.organizationId,
    auth.projectId ?? undefined,
    walletId
  );
}

function walletOperationStatusForDecision(decision: PolicyDecision): WalletOperationStatus {
  switch (decision) {
    case "allow":
      return "evaluated";
    case "approval_required":
    case "provider_approval_required":
    case "review":
      return "pending_approval";
    case "deny":
    case "not_evaluated":
      return "failed";
  }
}

function walletOperationPolicyDecisionError(
  operation: WalletOperationEnvelope,
  evaluation: PolicyEvaluation
): AppError {
  const details = {
    walletOperationId: operation.id,
    policyEvaluationId: evaluation.id,
    decision: evaluation.decision,
    reasonCode: evaluation.reasonCode,
    reason: evaluation.reason,
    requiresApproval: evaluation.requiresApproval,
    approvalRequestId: evaluation.approvalRequestId,
  };

  if (evaluation.decision === "deny" || evaluation.decision === "not_evaluated") {
    const message =
      evaluation.decision === "not_evaluated"
        ? "Wallet operation was not evaluated by policy"
        : "Wallet operation denied by policy";
    return new AppError("FORBIDDEN", message, details);
  }

  return new AppError("SIGNING_PENDING", "Wallet operation requires policy approval", details);
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
    providerReference:
      stringValue(operation.providerExtensions.providerReference) ??
      stringValue(operation.providerExtensions.approvalId) ??
      stringValue(operation.providerExtensions.approvalRequestId),
    providerPayload: operation.providerExtensions,
    requestedBy: typeof operation.actor?.id === "string" ? operation.actor.id : null,
  };
}

function getApprovalGroupId(evaluation: WalletOperationPolicyEvaluation): string | null {
  for (const matchedRule of evaluation.matchedRules) {
    const approvalGroupId = stringValue(matchedRule.rule.approvalGroupId);
    if (approvalGroupId) {
      return approvalGroupId;
    }
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
