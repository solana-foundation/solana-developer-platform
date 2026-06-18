import type {
  ApiKeyControlProfile,
  ApiKeyControlProfileRevision,
  ApiKeyWalletPolicyBinding,
  EffectiveApiKeyPolicy,
  EffectiveWalletPolicy,
  PolicyEvaluation,
  WalletControlProfile,
  WalletControlProfileRevision,
  WalletOperationActor,
  WalletOperationContext,
  WalletOperationEnvelope,
  WalletOperationPolicyEvaluation,
  WalletOperationProviderExtensions,
} from "@sdp/types";
import type {
  ApiKeyControlProfileRevisionRow,
  ApiKeyControlProfileRow,
  ApiKeyWalletPolicyBindingRow,
  CreatePolicyEvaluationInput,
  CreateWalletOperationInput,
  PolicyEvaluationRow,
  PolicyRepository,
  WalletControlProfileRevisionRow,
  WalletControlProfileRow,
  WalletOperationRow,
} from "@/db/repositories";
import {
  createPolicyEvaluationInput,
  evaluateWalletOperationPolicies,
} from "./policy-evaluation.service";

export const IMPLICIT_DEFAULT_ALLOW_POLICY = {
  source: "implicit_default_allow",
  profile: null,
  revision: null,
  defaultAction: "allow",
} as const satisfies EffectiveWalletPolicy;

export class PolicyFoundationService {
  constructor(private readonly repository: PolicyRepository) {}

  async resolveEffectiveWalletPolicy(custodyWalletId: string): Promise<EffectiveWalletPolicy> {
    const active =
      await this.repository.getActiveWalletControlProfileByCustodyWalletId(custodyWalletId);

    if (!active?.revision) {
      return IMPLICIT_DEFAULT_ALLOW_POLICY;
    }

    return {
      source: "customer_profile",
      profile: mapWalletControlProfile(active.profile),
      revision: mapWalletControlProfileRevision(active.revision),
      defaultAction: active.revision.default_action,
    };
  }

  async resolveEffectiveApiKeyPolicy(apiKeyId: string): Promise<EffectiveApiKeyPolicy> {
    const active = await this.repository.getActiveApiKeyControlProfileByApiKeyId(apiKeyId);

    if (!active?.revision) {
      return {
        source: "implicit_default_allow",
        profile: null,
        revision: null,
        defaultAction: "allow",
      };
    }

    return {
      source: "customer_profile",
      profile: mapApiKeyControlProfile(active.profile),
      revision: mapApiKeyControlProfileRevision(active.revision),
      defaultAction: active.revision.default_action,
    };
  }

  async listApiKeyWalletPolicyBindings(apiKeyId: string): Promise<ApiKeyWalletPolicyBinding[]> {
    const rows = await this.repository.listApiKeyWalletPolicyBindings(apiKeyId);
    return rows.map(mapApiKeyWalletPolicyBinding);
  }

  async recordWalletOperation(input: CreateWalletOperationInput): Promise<WalletOperationEnvelope> {
    const row = await this.repository.createWalletOperation(input);
    if (!row) {
      throw new Error("Failed to record wallet operation");
    }

    return mapWalletOperation(row);
  }

  async recordPolicyEvaluation(input: CreatePolicyEvaluationInput): Promise<PolicyEvaluation> {
    const row = await this.repository.createPolicyEvaluation(input);
    if (!row) {
      throw new Error("Failed to record policy evaluation");
    }

    return mapPolicyEvaluation(row);
  }

  async evaluateWalletOperationPolicies(
    operation: WalletOperationEnvelope
  ): Promise<WalletOperationPolicyEvaluation> {
    const walletPolicy = operation.custodyWalletId
      ? await this.resolveEffectiveWalletPolicy(operation.custodyWalletId)
      : IMPLICIT_DEFAULT_ALLOW_POLICY;
    const apiKeyPolicy = operation.apiKeyId
      ? await this.resolveEffectiveApiKeyPolicy(operation.apiKeyId)
      : null;

    return evaluateWalletOperationPolicies({
      operation,
      walletPolicy,
      apiKeyPolicy,
    });
  }

  async recordWalletOperationPolicyEvaluation(
    operation: WalletOperationEnvelope
  ): Promise<PolicyEvaluation> {
    const result = await this.evaluateWalletOperationPolicies(operation);
    return this.recordPolicyEvaluation(createPolicyEvaluationInput(result));
  }
}

function mapWalletControlProfile(row: WalletControlProfileRow): WalletControlProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    custodyWalletId: row.custody_wallet_id,
    name: row.name,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    archivedAt: row.archived_at,
  };
}

function mapWalletControlProfileRevision(
  row: WalletControlProfileRevisionRow
): WalletControlProfileRevision {
  return {
    id: row.id,
    profileId: row.profile_id,
    revisionNumber: row.revision_number,
    rules: row.rules as unknown as WalletControlProfileRevision["rules"],
    defaultAction: row.default_action,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}

function mapApiKeyControlProfile(row: ApiKeyControlProfileRow): ApiKeyControlProfile {
  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    apiKeyId: row.api_key_id,
    name: row.name,
    status: row.status,
    activeRevisionId: row.active_revision_id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    archivedAt: row.archived_at,
  };
}

function mapApiKeyControlProfileRevision(
  row: ApiKeyControlProfileRevisionRow
): ApiKeyControlProfileRevision {
  return {
    id: row.id,
    profileId: row.profile_id,
    revisionNumber: row.revision_number,
    rules: row.rules as unknown as ApiKeyControlProfileRevision["rules"],
    defaultAction: row.default_action,
    createdBy: row.created_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}

function mapApiKeyWalletPolicyBinding(
  row: ApiKeyWalletPolicyBindingRow
): ApiKeyWalletPolicyBinding {
  return {
    id: row.id,
    apiKeyId: row.api_key_id,
    bindingScope: row.binding_scope,
    walletId: row.wallet_id,
    custodyWalletId: row.custody_wallet_id,
    walletControlProfileId: row.wallet_control_profile_id,
    apiKeyControlProfileId: row.api_key_control_profile_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWalletOperation(row: WalletOperationRow): WalletOperationEnvelope {
  const actor = getWalletOperationActor(row);

  return {
    id: row.id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    custodyWalletId: row.custody_wallet_id,
    walletId: row.wallet_id,
    apiKeyId: row.api_key_id,
    actor,
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
  if (isJsonObject(row.raw_payload.actor)) {
    return row.raw_payload.actor as WalletOperationActor;
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
