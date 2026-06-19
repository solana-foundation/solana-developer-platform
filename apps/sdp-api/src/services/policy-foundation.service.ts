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
  ApiKeyPolicySubjectRow,
  ApiKeyWalletPolicyBindingResolutionRow,
  ApiKeyWalletPolicyBindingRow,
  ApiKeyWalletPolicyTargetRow,
  CreatePolicyEvaluationInput,
  CreateWalletOperationInput,
  PolicyEvaluationRow,
  PolicyRepository,
  UpsertApiKeyWalletPolicyBindingInput,
  WalletControlProfileRevisionRow,
  WalletControlProfileRow,
  WalletOperationRow,
} from "@/db/repositories";
import { badRequest, forbidden } from "@/lib/errors";
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

const IMPLICIT_DEFAULT_ALLOW_API_KEY_POLICY = {
  source: "implicit_default_allow",
  profile: null,
  revision: null,
  defaultAction: "allow",
} as const satisfies EffectiveApiKeyPolicy;

export interface ResolveApiKeyWalletPolicyScopeInput {
  apiKeyId: string;
  walletId: string;
  custodyWalletId?: string | null;
}

export interface ResolvedApiKeyWalletPolicyScope {
  target: {
    apiKeyId: string;
    organizationId: string;
    projectId: string | null;
    walletId: string;
    custodyWalletId: string;
    walletProjectId: string | null;
  };
  binding: ApiKeyWalletPolicyBinding | null;
  walletPolicy: EffectiveWalletPolicy | null;
  apiKeyPolicy: EffectiveApiKeyPolicy;
}

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
      return IMPLICIT_DEFAULT_ALLOW_API_KEY_POLICY;
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

  async upsertApiKeyWalletPolicyBinding(
    input: UpsertApiKeyWalletPolicyBindingInput
  ): Promise<ApiKeyWalletPolicyBinding> {
    if (input.bindingScope === "selected") {
      const target = await this.assertApiKeyWalletPolicyTarget({
        apiKeyId: input.apiKeyId,
        walletId: input.walletId,
        custodyWalletId: input.custodyWalletId,
      });

      if (input.apiKeyControlProfileId) {
        await this.resolveApiKeyPolicyProfileForBinding(
          input.apiKeyControlProfileId,
          target,
          input.apiKeyId
        );
      }
      if (input.walletControlProfileId) {
        await this.resolveWalletPolicyProfileForBinding(input.walletControlProfileId, target);
      }

      const row = await this.repository.upsertApiKeyWalletPolicyBinding({
        ...input,
        custodyWalletId: target.custody_wallet_id,
      });
      if (!row) {
        throw new Error("Failed to upsert API key wallet policy binding");
      }
      return mapApiKeyWalletPolicyBinding(row);
    }

    const subject = await this.assertApiKeyPolicySubject(input.apiKeyId);

    if (input.walletControlProfileId) {
      throw badRequest("walletControlProfileId cannot be used with all-wallet policy bindings");
    }
    if (input.apiKeyControlProfileId) {
      await this.resolveApiKeyPolicyProfileForBinding(
        input.apiKeyControlProfileId,
        subject,
        input.apiKeyId
      );
    }

    const row = await this.repository.upsertApiKeyWalletPolicyBinding(input);
    if (!row) {
      throw new Error("Failed to upsert API key wallet policy binding");
    }
    return mapApiKeyWalletPolicyBinding(row);
  }

  async resolveApiKeyWalletPolicyScope(
    input: ResolveApiKeyWalletPolicyScopeInput
  ): Promise<ResolvedApiKeyWalletPolicyScope> {
    const resolution = await this.repository.getApiKeyWalletPolicyBindingResolution(
      input.apiKeyId,
      input.walletId
    );

    this.assertApplicablePolicyBindingExists(resolution);

    const target = await this.assertApiKeyWalletPolicyTarget(input);
    return await this.resolveApiKeyWalletPolicyScopeForTarget(input, target, resolution);
  }

  private async resolveApiKeyWalletPolicyScopeForTarget(
    input: ResolveApiKeyWalletPolicyScopeInput,
    target: ApiKeyWalletPolicyTargetRow,
    resolution: ApiKeyWalletPolicyBindingResolutionRow
  ): Promise<ResolvedApiKeyWalletPolicyScope> {
    const binding = resolution.binding;

    if (resolution.total_binding_count > 0 && !binding) {
      throw forbidden("API key policy binding is not configured for the requested wallet");
    }

    if (!binding) {
      return {
        target: mapApiKeyWalletPolicyTarget(target),
        binding: null,
        walletPolicy: null,
        apiKeyPolicy: await this.resolveEffectiveApiKeyPolicy(input.apiKeyId),
      };
    }

    this.assertPolicyBindingMatchesTarget(binding, target);

    const walletPolicy = binding.wallet_control_profile_id
      ? await this.resolveWalletPolicyProfileForBinding(binding.wallet_control_profile_id, target)
      : null;

    const apiKeyPolicy = binding.api_key_control_profile_id
      ? await this.resolveApiKeyPolicyProfileForBinding(
          binding.api_key_control_profile_id,
          target,
          input.apiKeyId
        )
      : await this.resolveEffectiveApiKeyPolicy(input.apiKeyId);

    return {
      target: mapApiKeyWalletPolicyTarget(target),
      binding: mapApiKeyWalletPolicyBinding(binding),
      walletPolicy,
      apiKeyPolicy,
    };
  }

  async resolveEffectiveApiKeyPolicyForWallet(
    input: ResolveApiKeyWalletPolicyScopeInput
  ): Promise<EffectiveApiKeyPolicy> {
    const scoped = await this.resolveApiKeyWalletPolicyScope(input);
    return scoped.apiKeyPolicy;
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
    let apiKeyScope: ResolvedApiKeyWalletPolicyScope | null = null;
    let apiKeyPolicy: EffectiveApiKeyPolicy | null = null;

    if (operation.apiKeyId) {
      const resolution = await this.repository.getApiKeyWalletPolicyBindingResolution(
        operation.apiKeyId,
        operation.walletId
      );

      if (resolution.total_binding_count > 0) {
        this.assertApplicablePolicyBindingExists(resolution);
        // Once an API key has wallet policy bindings, an inactive or out-of-scope
        // requested wallet must fail closed instead of falling back to legacy policy lookup.
        const input = {
          apiKeyId: operation.apiKeyId,
          walletId: operation.walletId,
          custodyWalletId: operation.custodyWalletId,
        };
        const target = await this.assertApiKeyWalletPolicyTarget(input);
        apiKeyScope = await this.resolveApiKeyWalletPolicyScopeForTarget(input, target, resolution);
        apiKeyPolicy = apiKeyScope.apiKeyPolicy;
      } else {
        apiKeyPolicy = await this.resolveEffectiveApiKeyPolicy(operation.apiKeyId);
      }
    }

    const custodyWalletId = apiKeyScope?.target.custodyWalletId ?? operation.custodyWalletId;
    const walletPolicy =
      apiKeyScope?.walletPolicy ??
      (custodyWalletId
        ? await this.resolveEffectiveWalletPolicy(custodyWalletId)
        : IMPLICIT_DEFAULT_ALLOW_POLICY);

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

  private async assertApiKeyPolicySubject(apiKeyId: string): Promise<ApiKeyPolicySubjectRow> {
    const subject = await this.repository.getApiKeyPolicySubject(apiKeyId);

    if (!subject) {
      throw forbidden("API key is not active for policy binding");
    }

    return subject;
  }

  private assertApplicablePolicyBindingExists(
    resolution: ApiKeyWalletPolicyBindingResolutionRow
  ): void {
    if (resolution.total_binding_count > 0 && !resolution.binding) {
      throw forbidden("API key policy binding is not configured for the requested wallet");
    }
  }

  private async assertApiKeyWalletPolicyTarget(
    input: ResolveApiKeyWalletPolicyScopeInput
  ): Promise<ApiKeyWalletPolicyTargetRow> {
    const target = await this.repository.getApiKeyWalletPolicyTarget(
      input.apiKeyId,
      input.walletId
    );

    if (!target) {
      throw forbidden("API key is not authorized for the requested wallet");
    }

    if (input.custodyWalletId && input.custodyWalletId !== target.custody_wallet_id) {
      throw forbidden("API key wallet policy target does not match the requested custody wallet");
    }

    if (
      target.project_id !== null &&
      target.wallet_project_id !== null &&
      target.wallet_project_id !== target.project_id
    ) {
      throw forbidden("Project API keys cannot use wallets from other projects");
    }

    if (target.endpoint_binding_count > 0 && !target.endpoint_wallet_binding_id) {
      throw forbidden("API key is not authorized for the requested wallet");
    }

    return target;
  }

  private assertPolicyBindingMatchesTarget(
    binding: ApiKeyWalletPolicyBindingRow,
    target: ApiKeyWalletPolicyTargetRow
  ): void {
    if (binding.binding_scope === "selected" && binding.wallet_id !== target.wallet_id) {
      throw forbidden("API key policy binding does not match the requested wallet");
    }

    if (binding.custody_wallet_id && binding.custody_wallet_id !== target.custody_wallet_id) {
      throw forbidden("API key policy binding does not match the requested custody wallet");
    }
  }

  private async resolveApiKeyPolicyProfileForBinding(
    profileId: string,
    subject: ApiKeyPolicySubjectRow,
    apiKeyId: string
  ): Promise<EffectiveApiKeyPolicy> {
    const active = await this.repository.getActiveApiKeyControlProfileByProfileId(profileId);

    if (!active?.revision) {
      throw forbidden("API key policy profile is not active for the requested wallet binding");
    }

    if (
      active.profile.api_key_id !== apiKeyId ||
      active.profile.organization_id !== subject.organization_id ||
      (active.profile.project_id !== null && active.profile.project_id !== subject.project_id)
    ) {
      throw forbidden("API key policy profile is not scoped to the requested API key");
    }

    return {
      source: "customer_profile",
      profile: mapApiKeyControlProfile(active.profile),
      revision: mapApiKeyControlProfileRevision(active.revision),
      defaultAction: active.revision.default_action,
    };
  }

  private async resolveWalletPolicyProfileForBinding(
    profileId: string,
    target: ApiKeyWalletPolicyTargetRow
  ): Promise<EffectiveWalletPolicy> {
    const active = await this.repository.getActiveWalletControlProfileByProfileId(profileId);

    if (!active?.revision) {
      throw forbidden("Wallet policy profile is not active for the requested wallet binding");
    }

    if (
      active.profile.custody_wallet_id !== target.custody_wallet_id ||
      active.profile.organization_id !== target.organization_id ||
      (active.profile.project_id !== null && active.profile.project_id !== target.wallet_project_id)
    ) {
      throw forbidden("Wallet policy profile is not scoped to the requested wallet");
    }

    return {
      source: "customer_profile",
      profile: mapWalletControlProfile(active.profile),
      revision: mapWalletControlProfileRevision(active.revision),
      defaultAction: active.revision.default_action,
    };
  }
}

function mapApiKeyWalletPolicyTarget(row: ApiKeyWalletPolicyTargetRow) {
  return {
    apiKeyId: row.api_key_id,
    organizationId: row.organization_id,
    projectId: row.project_id,
    walletId: row.wallet_id,
    custodyWalletId: row.custody_wallet_id,
    walletProjectId: row.wallet_project_id,
  };
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
