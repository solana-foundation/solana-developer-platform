import type {
  PolicyDecision,
  PolicyEvaluation,
  WalletOperationActor,
  WalletOperationEnvelope,
  WalletOperationStatus,
} from "@sdp/types";
import { getDb } from "@/db";
import {
  type CreateWalletOperationInput,
  createPolicyRepository,
  type PolicyRepository,
} from "@/db/repositories";
import type { ApiKeyContext } from "@/lib/auth";
import { AppError, internalError } from "@/lib/errors";
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
    const result = await this.foundation.evaluateWalletOperationPolicies(operation);
    const evaluation = await this.foundation.recordPolicyEvaluation(
      createPolicyEvaluationInput(result)
    );
    const status = walletOperationStatusForDecision(result.decision);
    const updated = await this.repository.updateWalletOperationStatus(operation.id, status);

    if (!updated) {
      throw internalError("Failed to update wallet operation policy status");
    }

    const updatedOperation: WalletOperationEnvelope = {
      ...operation,
      status: updated.status,
      updatedAt: updated.updated_at,
    };

    if (result.decision === "allow") {
      return {
        operation: updatedOperation,
        evaluation,
      };
    }

    throw walletOperationPolicyDecisionError(updatedOperation, evaluation);
  }
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
  };

  if (evaluation.decision === "deny" || evaluation.decision === "not_evaluated") {
    return new AppError("FORBIDDEN", "Wallet operation denied by policy", details);
  }

  return new AppError("SIGNING_PENDING", "Wallet operation requires policy approval", details);
}
