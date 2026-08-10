import {
  type CreateWalletOperationInput,
  enforceWalletOperationPolicy as runPolicyEnforcement,
  type WalletOperationPolicyEnforcement,
} from "@sdp/policy";
import type {
  PolicyEvaluation,
  WalletOperationActor,
  WalletOperationContext,
  WalletOperationEnvelope,
  WalletOperationProviderExtensions,
} from "@sdp/types";
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
  input: CreateWalletOperationInput,
  approvedOperationId?: string,
  approvedOperationAttemptId?: string
): Promise<WalletOperationPolicyEnforcement> {
  assertTenantClaim(scope, input, "enforceWalletOperationPolicy");
  const service = new WalletPolicyEnforcementService(createPolicyRepository(env, scope), scope);
  if (approvedOperationId) {
    if (!approvedOperationAttemptId) {
      throw new AppError("FORBIDDEN", "Approved wallet operation attempt is unavailable");
    }
    return service.resumeApprovedOperation(approvedOperationId, approvedOperationAttemptId, input);
  }
  return service.enforce(input);
}

/** Policy enforcement plus approval-request lifecycle transitions for wallet operations. */
export class WalletPolicyEnforcementService {
  constructor(
    private readonly repository: PolicyRepository,
    private readonly scope: TenantScope
  ) {}

  /**
   * Enforce policy on a wallet operation, throwing the route-contract error
   * for any non-allow decision.
   *
   * @param input - The operation to enforce.
   * @returns The recorded operation and its evaluation when allowed.
   */
  async enforce(input: CreateWalletOperationInput): Promise<WalletOperationPolicyEnforcement> {
    const store = new PostgresPolicyEnforcementStore(this.repository, this.scope);
    const enforcement = await runPolicyEnforcement(store, input);

    if (enforcement.evaluation.decision === "allow") {
      return enforcement;
    }

    throw walletOperationPolicyDecisionError(enforcement.operation, enforcement.evaluation);
  }

  async resumeApprovedOperation(
    walletOperationId: string,
    executionAttemptId: string,
    input: CreateWalletOperationInput
  ): Promise<WalletOperationPolicyEnforcement> {
    const operation = await this.repository.getWalletOperationById(walletOperationId);
    if (
      operation?.status !== "executing" ||
      operation.execution_started_at === null ||
      operation.execution_attempt_id !== executionAttemptId ||
      !operation.execution_lease_expires_at ||
      operation.execution_lease_expires_at <= new Date().toISOString()
    ) {
      throw new AppError("FORBIDDEN", "Wallet operation approval is not executable");
    }

    const matches =
      operation.organization_id === input.organizationId &&
      operation.project_id === input.projectId &&
      operation.custody_wallet_id === (input.custodyWalletId ?? null) &&
      operation.wallet_id === input.walletId &&
      operation.api_key_id === (input.apiKeyId ?? null) &&
      operation.operation_family === input.operationFamily &&
      operation.operation_type === input.operationType &&
      operation.asset === (input.asset ?? null) &&
      operation.amount === (input.amount ?? null) &&
      operation.destination === (input.destination ?? null) &&
      jsonValuesEqual(operation.raw_payload, walletOperationRawPayload(input));
    if (!matches) {
      throw new AppError("FORBIDDEN", "Approved wallet operation does not match replayed action");
    }

    const evaluations = await this.repository.listPolicyEvaluationsForOperation(walletOperationId);
    const original = evaluations.at(-1);
    if (
      !original?.requires_approval ||
      !original.approval_request_id ||
      !original.evaluation_context
    ) {
      throw new AppError("FORBIDDEN", "Wallet operation has no satisfied approval gate");
    }

    return {
      operation: {
        id: operation.id,
        organizationId: operation.organization_id,
        projectId: operation.project_id,
        custodyWalletId: operation.custody_wallet_id,
        walletId: operation.wallet_id,
        apiKeyId: operation.api_key_id,
        actor: storedOperationActor(operation.raw_payload),
        source: operation.source,
        operationFamily: operation.operation_family,
        operationType: operation.operation_type,
        asset: operation.asset,
        amount: operation.amount,
        destination: operation.destination,
        context: storedOperationContext(operation.raw_payload),
        providerExtensions: storedOperationProviderExtensions(operation.raw_payload),
        rawPayload: operation.raw_payload,
        idempotencyKey: operation.idempotency_key,
        status: operation.status,
        createdAt: operation.created_at,
        updatedAt: operation.updated_at,
      },
      evaluation: {
        id: original.id,
        walletOperationId: original.wallet_operation_id,
        walletPolicyRevisionId: original.wallet_policy_revision_id,
        apiKeyPolicyRevisionId: original.api_key_policy_revision_id,
        decision: "allow",
        reasonCode: "approval_satisfied",
        reason: "Required approval was granted",
        matchedRules: original.matched_rules,
        evaluationContext: original.evaluation_context,
        requiresApproval: false,
        approvalRequestId: original.approval_request_id,
        createdAt: original.created_at,
      },
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

function walletOperationRawPayload(input: CreateWalletOperationInput): Record<string, unknown> {
  return {
    ...(input.rawPayload ?? {}),
    ...(input.actor !== undefined ? { actor: input.actor } : {}),
    ...(input.context != null ? { context: input.context } : {}),
    ...(input.providerExtensions != null ? { providerExtensions: input.providerExtensions } : {}),
  };
}

function storedOperationContext(rawPayload: Record<string, unknown>): WalletOperationContext {
  return isJsonObject(rawPayload.context) ? rawPayload.context : {};
}

function storedOperationActor(rawPayload: Record<string, unknown>): WalletOperationActor | null {
  return isJsonObject(rawPayload.actor)
    ? (rawPayload.actor as unknown as WalletOperationActor)
    : null;
}

function storedOperationProviderExtensions(
  rawPayload: Record<string, unknown>
): WalletOperationProviderExtensions {
  if (isJsonObject(rawPayload.providerExtensions)) {
    return rawPayload.providerExtensions;
  }
  return typeof rawPayload.provider === "string" ? { provider: rawPayload.provider } : {};
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function stableJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, current) => {
    if (!isJsonObject(current)) {
      return current;
    }
    return Object.fromEntries(
      Object.entries(current).sort(([left], [right]) => left.localeCompare(right))
    );
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
