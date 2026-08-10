import type {
  CreateApprovalRequestInput,
  CreateWalletOperationInput,
  EffectiveOperationPolicies,
  PolicyEnforcementStore,
  RecordPolicyEvaluationInput,
} from "@sdp/policy";
import { IMPLICIT_DEFAULT_ALLOW_POLICY } from "@sdp/policy";
import type {
  EffectiveApiKeyPolicy,
  PolicyCandidate,
  PolicyEvaluation,
  WalletOperationActor,
  WalletOperationContext,
  WalletOperationEnvelope,
  WalletOperationProviderExtensions,
} from "@sdp/types";
import type { PolicyEvaluationRow, PolicyRepository, WalletOperationRow } from "@/db/repositories";
import { internalError } from "@/lib/errors";
import { assertTenantClaim, type TenantScope } from "@/lib/tenant-scope";
import { ApiKeyPolicyStore } from "./api-key-policy.store";
import { WalletPolicyStore } from "./wallet-policy.store";

/**
 * Postgres-backed {@link PolicyEnforcementStore}: wallet-operation lifecycle
 * rows plus effective-policy resolution composed from the wallet and API-key
 * scope stores.
 */
export class PostgresPolicyEnforcementStore implements PolicyEnforcementStore {
  private readonly walletPolicies: WalletPolicyStore;
  private readonly apiKeyPolicies: ApiKeyPolicyStore;

  constructor(
    private readonly repository: PolicyRepository,
    private readonly scope: TenantScope
  ) {
    this.walletPolicies = new WalletPolicyStore(repository);
    this.apiKeyPolicies = new ApiKeyPolicyStore(repository);
  }

  async createWalletOperation(input: CreateWalletOperationInput): Promise<WalletOperationEnvelope> {
    const row = await this.repository.createWalletOperation(input);
    if (!row) {
      throw internalError("Failed to record wallet operation");
    }
    return mapWalletOperation(row);
  }

  /**
   * Resolve both policy scopes for a candidate, letting a binding-supplied
   * wallet policy or custody wallet from the API-key scope take precedence.
   * The candidate's claimed tenant must match the store's bound scope, so a
   * mismatched candidate fails before any lookup runs.
   *
   * @param candidate - The candidate whose scopes resolve the policies.
   * @returns The effective wallet and API-key policies.
   */
  async loadEffectivePolicies(
    candidate: Pick<
      PolicyCandidate,
      "organizationId" | "projectId" | "apiKeyId" | "custodyWalletId"
    >
  ): Promise<EffectiveOperationPolicies> {
    assertTenantClaim(this.scope, candidate, "PolicyEnforcementStore.loadEffectivePolicies");
    const apiKeyScope =
      candidate.apiKeyId !== null && candidate.custodyWalletId !== null
        ? await this.apiKeyPolicies.resolveOperationScope({
            apiKeyId: candidate.apiKeyId,
            custodyWalletId: candidate.custodyWalletId,
          })
        : null;

    let apiKeyPolicy: EffectiveApiKeyPolicy | null = null;
    if (apiKeyScope !== null) {
      apiKeyPolicy = apiKeyScope.apiKeyPolicy;
    } else if (candidate.apiKeyId !== null) {
      apiKeyPolicy = await this.apiKeyPolicies.resolveOperationPolicyWithoutCustodyWallet(
        candidate.apiKeyId
      );
    }

    if (apiKeyScope !== null && apiKeyScope.walletPolicy !== null) {
      return { walletPolicy: apiKeyScope.walletPolicy, apiKeyPolicy };
    }

    const custodyWalletId =
      apiKeyScope !== null && apiKeyScope.custodyWalletId !== null
        ? apiKeyScope.custodyWalletId
        : candidate.custodyWalletId;
    const walletPolicy =
      custodyWalletId !== null
        ? await this.walletPolicies.resolveEffectiveWalletPolicy(custodyWalletId)
        : IMPLICIT_DEFAULT_ALLOW_POLICY;

    return {
      walletPolicy,
      apiKeyPolicy,
    };
  }

  async createApprovalRequest(input: CreateApprovalRequestInput) {
    const row = await this.repository.createApprovalRequest(input);
    if (!row) {
      throw internalError("Failed to create wallet operation approval request");
    }
    return { id: row.id, status: row.status };
  }

  async recordPolicyEvaluation(input: RecordPolicyEvaluationInput): Promise<PolicyEvaluation> {
    const row = await this.repository.createPolicyEvaluation({
      walletOperationId: input.walletOperationId,
      walletPolicyRevisionId: input.walletPolicyRevisionId,
      apiKeyPolicyRevisionId: input.apiKeyPolicyRevisionId,
      decision: input.decision,
      reasonCode: input.reasonCode,
      reason: input.reason,
      matchedRules: input.matchedRules.map((rule) => ({ ...rule })),
      evaluationContext: input.evaluationContext,
      requiresApproval: input.requiresApproval,
      approvalRequestId: input.approvalRequestId,
    });
    if (!row) {
      throw internalError("Failed to record wallet operation policy evaluation");
    }
    return mapPolicyEvaluation(row);
  }

  async updateWalletOperationStatus(
    walletOperationId: string,
    status: WalletOperationEnvelope["status"]
  ) {
    const updated = await this.repository.updateWalletOperationStatus(walletOperationId, status);
    if (!updated) {
      throw internalError("Failed to update wallet operation policy status");
    }
    return { status: updated.status, updatedAt: updated.updated_at };
  }

  async failApprovalRequest(
    operation: WalletOperationEnvelope,
    approvalRequestId: string
  ): Promise<void> {
    await this.repository.updateApprovalRequestStatus({
      organizationId: operation.organizationId,
      projectId: operation.projectId,
      approvalRequestId,
      status: "failed",
      operationStatus: "failed",
    });
  }
}

/**
 * Map a wallet-operation row onto its domain envelope.
 *
 * @param row - The persisted row.
 * @returns The domain envelope.
 */
function mapWalletOperation(row: WalletOperationRow): WalletOperationEnvelope {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    custodyWalletId: row.custody_wallet_id,
    walletId: row.wallet_id,
    apiKeyId: row.api_key_id,
    actor: getWalletOperationActor(row),
    source: row.source,
    operationFamily: row.operation_family,
    operationType: row.operation_type,
    asset: row.asset,
    amount: row.amount,
    destination: row.destination,
    context: getJsonObject(row.raw_payload.context),
    providerExtensions: getWalletOperationProviderExtensions(row.raw_payload),
    rawPayload: row.raw_payload,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getWalletOperationActor(row: WalletOperationRow): WalletOperationActor | null {
  if (Object.hasOwn(row.raw_payload, "actor")) {
    return isJsonObject(row.raw_payload.actor)
      ? (row.raw_payload.actor as WalletOperationActor)
      : null;
  }
  if (row.api_key_id) {
    return {
      type: "api_key",
      id: row.api_key_id,
      apiKeyId: row.api_key_id,
    };
  }
  return null;
}

function getWalletOperationProviderExtensions(
  rawPayload: Record<string, unknown>
): WalletOperationProviderExtensions {
  if (isJsonObject(rawPayload.providerExtensions)) {
    return rawPayload.providerExtensions;
  }
  if (typeof rawPayload.provider === "string") {
    return { provider: rawPayload.provider };
  }
  return {};
}

function getJsonObject(value: unknown): WalletOperationContext {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Map a policy-evaluation row onto its domain shape.
 *
 * @param row - The persisted row.
 * @returns The domain evaluation.
 */
function mapPolicyEvaluation(row: PolicyEvaluationRow): PolicyEvaluation {
  return {
    id: row.id,
    walletOperationId: row.wallet_operation_id,
    walletPolicyRevisionId: row.wallet_policy_revision_id,
    apiKeyPolicyRevisionId: row.api_key_policy_revision_id,
    decision: row.decision,
    reasonCode: row.reason_code,
    reason: row.reason,
    matchedRules: row.matched_rules,
    evaluationContext: row.evaluation_context,
    requiresApproval: row.requires_approval,
    approvalRequestId: row.approval_request_id,
    createdAt: row.created_at,
  };
}
