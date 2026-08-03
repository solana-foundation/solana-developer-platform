import {
  type CreateWalletOperationInput,
  enforceWalletOperationPolicy as runPolicyEnforcement,
  type WalletOperationPolicyEnforcement,
} from "@sdp/policy";
import type { PolicyEvaluation, WalletOperationActor, WalletOperationEnvelope } from "@sdp/types";
import { getDb } from "@/db";
import {
  type ApprovalRequestRow,
  createPolicyRepository,
  type PolicyRepository,
} from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, conflict } from "@/lib/errors";
import { assertTenantClaim, createTenantScope, type TenantScope } from "@/lib/tenant-scope";
import { getLogger } from "@/runtime/logger";
import {
  CustodyConfigStore,
  type CustodyWalletLookup,
} from "@/services/stores/custody-config.store";
import type { Env } from "@/types/env";
import { PostgresPolicyEnforcementStore } from "./enforcement.store";

/**
 * Enforce policy on a wallet operation and translate the decision into the
 * route contract: allowed operations return, denied operations throw
 * FORBIDDEN, and approval-pending operations throw SIGNING_PENDING.
 *
 * @param env - The runtime environment.
 * @param scope - The trusted tenant scope of the request.
 * @param input - The operation to enforce.
 * @returns The recorded operation and its evaluation when allowed.
 */
export async function enforceWalletOperationPolicy(
  env: Env,
  scope: TenantScope,
  input: CreateWalletOperationInput
): Promise<WalletOperationPolicyEnforcement> {
  assertTenantClaim(scope, input, "enforceWalletOperationPolicy");
  const service = new WalletPolicyEnforcementService(createPolicyRepository(env, scope));
  return service.enforce(input);
}

/** Policy enforcement plus approval-request lifecycle transitions for wallet operations. */
export class WalletPolicyEnforcementService {
  constructor(private readonly repository: PolicyRepository) {}

  /**
   * Enforce policy on a wallet operation, throwing the route-contract error
   * for any non-allow decision.
   *
   * @param input - The operation to enforce.
   * @returns The recorded operation and its evaluation when allowed.
   */
  async enforce(input: CreateWalletOperationInput): Promise<WalletOperationPolicyEnforcement> {
    const store = new PostgresPolicyEnforcementStore(this.repository);
    const enforcement = await runPolicyEnforcement(store, input);

    if (enforcement.evaluation.decision === "allow") {
      return enforcement;
    }

    throw walletOperationPolicyDecisionError(enforcement.operation, enforcement.evaluation);
  }

  async approveApprovalRequest(
    organizationId: string,
    approvalRequestId: string,
    resolvedBy?: string | null,
    projectId?: string | null
  ) {
    const approvalRequest = await this.repository.updateApprovalRequestStatus({
      organizationId,
      projectId: projectId === undefined ? null : projectId,
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
      projectId: projectId === undefined ? null : projectId,
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
      projectId: projectId === undefined ? null : projectId,
      approvalRequestId,
      status: "rejected",
      operationStatus: "canceled",
      resolvedBy,
    });

    return requireApprovalRequestStatus(approvalRequest, "rejected");
  }
}

/**
 * Record a legacy wallet-policy denial against an operation the new engine
 * already allowed, so the legacy decision stays visible in the audit trail.
 *
 * @param env - The runtime environment.
 * @param enforcement - The enforcement the legacy check overruled.
 * @param error - The legacy denial.
 */
export async function recordLegacyWalletPolicyDenial(
  env: Env,
  enforcement: WalletOperationPolicyEnforcement,
  error: unknown
): Promise<void> {
  const repository = createPolicyRepository(
    env,
    createTenantScope({
      organizationId: enforcement.operation.organizationId,
      projectId: enforcement.operation.projectId,
    })
  );
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
    getLogger().error(
      {
        walletOperationId: enforcement.operation.id,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      },
      "Failed to record legacy wallet policy denial"
    );
  }
}

/**
 * Derive the wallet-operation actor from the authenticated context.
 *
 * @param auth - The authenticated API context.
 * @returns The actor, or null when the context names no principal.
 */
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

/**
 * Resolve the custody wallet a policy-gated route references.
 *
 * @param env - The runtime environment.
 * @param auth - The authenticated API context.
 * @param walletId - The wallet identifier from the request.
 * @returns The custody wallet, or null when none matches.
 */
export async function resolvePolicyCustodyWallet(
  env: Env,
  auth: ApiKeyContext,
  walletId: string
): Promise<CustodyWalletLookup | null> {
  const store = new CustodyConfigStore(getDb(env), env);
  return store.findActiveWalletByIdentifier(
    auth.organizationId,
    auth.projectId === null ? undefined : auth.projectId,
    walletId
  );
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
