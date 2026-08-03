import type {
  PolicyDecision,
  PolicyEvaluation,
  WalletOperationActor,
  WalletOperationEnvelope,
  WalletOperationPolicyEvaluation,
  WalletOperationStatus,
} from "@sdp/types";
import { asTransactionalClient, getDb } from "@/db";
import {
  type ApprovalRequestRow,
  type CreateApprovalRequestInput,
  type CreateWalletOperationInput,
  createPostgresPolicyRepository,
  type PolicyRepository,
} from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, conflict, internalError } from "@/lib/errors";
import { assertTenantClaim, type TenantScope } from "@/lib/tenant-scope";
import {
  CustodyConfigStore,
  type CustodyWalletLookup,
} from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { type BatchPolicyLeg, createPolicyEvaluationInput } from "./policy-evaluation.service";
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

  /**
   * Records the wallet operation, evaluates policy, and persists the
   * evaluation outcome. Assumes the service's repository is bound to a single
   * database transaction: any failure rolls back every write, so no orphaned
   * operation or approval-request rows can exist. Returns for every decision
   * — callers throw the decision error after the transaction commits so
   * denied and pending operations keep their audit trail.
   *
   * @param input - The candidate wallet operation.
   * @param legs - Per-recipient legs for batch operations.
   * @returns The persisted operation and its policy evaluation.
   */
  async enforce(
    input: CreateWalletOperationInput,
    legs?: BatchPolicyLeg[]
  ): Promise<WalletOperationPolicyEnforcement> {
    const operation = await this.foundation.recordWalletOperation({
      ...input,
      status: input.status ?? "created",
    });

    const result = await this.foundation.evaluateWalletOperationPolicies(operation, legs);
    const status = walletOperationStatusForDecision(result.decision);
    let approvalRequestId: string | null = null;

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
      operation: {
        ...operation,
        status: updated.status,
        updatedAt: updated.updated_at,
      },
      evaluation,
    };
  }

  async approveApprovalRequest(
    organizationId: string,
    approvalRequestId: string,
    resolvedBy?: string | null,
    projectId?: string | null
  ) {
    const approvalRequest = await this.repository.updateApprovalRequestStatus({
      organizationId,
      projectId: projectId ?? null,
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
    resolvedBy?: string | null,
    projectId?: string | null
  ) {
    const approvalRequest = await this.repository.updateApprovalRequestStatus({
      organizationId,
      projectId: projectId ?? null,
      approvalRequestId,
      status: "canceled",
      operationStatus: "canceled",
      resolvedBy,
    });

    return requireApprovalRequestStatus(approvalRequest, "canceled");
  }

  async rejectApprovalRequest(
    organizationId: string,
    approvalRequestId: string,
    resolvedBy?: string | null,
    projectId?: string | null
  ) {
    const approvalRequest = await this.repository.updateApprovalRequestStatus({
      organizationId,
      projectId: projectId ?? null,
      approvalRequestId,
      status: "rejected",
      operationStatus: "canceled",
      resolvedBy,
    });

    return requireApprovalRequestStatus(approvalRequest, "rejected");
  }
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

/**
 * Enforces control-profile policy for a candidate wallet operation inside a
 * single database transaction: the operation row, any approval request, the
 * policy evaluation, and the status update commit together or not at all.
 * Non-allow decisions throw after the transaction commits, so denied and
 * pending operations keep their audit trail.
 *
 * @param env - Worker environment.
 * @param scope - The authenticated tenant scope.
 * @param input - The candidate wallet operation.
 * @param legs - Per-recipient legs for batch operations.
 * @returns The persisted operation and evaluation when the decision is allow.
 */
export async function enforceWalletOperationPolicy(
  env: Env,
  scope: TenantScope,
  input: CreateWalletOperationInput,
  legs?: BatchPolicyLeg[]
): Promise<WalletOperationPolicyEnforcement> {
  assertTenantClaim(scope, input, "enforceWalletOperationPolicy");
  const enforcement = await getDb(env).transaction(async (tx) => {
    const service = new WalletPolicyEnforcementService(
      createPostgresPolicyRepository(asTransactionalClient(tx), scope)
    );
    return service.enforce(input, legs);
  });

  if (enforcement.evaluation.decision === "allow") {
    return enforcement;
  }

  throw walletOperationPolicyDecisionError(enforcement.operation, enforcement.evaluation);
}

/**
 * Builds the wallet-operation actor for a bare API key id, for contexts that
 * carry only the initiating key (background collections) rather than a full
 * auth context.
 *
 * @param apiKeyId - The initiating API key id, if any.
 * @returns The api_key actor, or null when no key initiated the operation.
 */
export function walletOperationActorFromApiKeyId(
  apiKeyId: string | null
): WalletOperationActor | null {
  if (apiKeyId === null) {
    return null;
  }

  return {
    type: "api_key",
    id: apiKeyId,
    apiKeyId,
  };
}

export function walletOperationActorFromAuth(auth: ApiKeyContext): WalletOperationActor | null {
  if (auth.apiKeyId) {
    return walletOperationActorFromApiKeyId(auth.apiKeyId);
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
  const store = new CustodyConfigStore(getDb(env), env);
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
