import { IMPLICIT_DEFAULT_ALLOW_POLICY } from "@sdp/policy";
import type {
  ApiKeyControlProfile,
  ApiKeyControlProfileRevision,
  ApiKeyWalletPolicyBinding,
  EffectiveApiKeyPolicy,
  EffectiveWalletPolicy,
  PolicyDefaultAction,
  PolicyRule,
} from "@sdp/types";
import type {
  ApiKeyControlProfileRevisionRow,
  ApiKeyControlProfileRow,
  ApiKeyPolicySubjectRow,
  ApiKeyWalletPolicyBindingResolutionRow,
  ApiKeyWalletPolicyBindingRow,
  ApiKeyWalletPolicyTargetRow,
  PolicyRepository,
  UpsertApiKeyWalletPolicyBindingInput,
} from "@/db/repositories";
import { badRequest, forbidden, internalError, notFound } from "@/lib/errors";
import { WalletPolicyStore } from "./wallet-policy.store";

export interface ResolveApiKeyWalletPolicyScopeInput {
  apiKeyId: string;
  custodyWalletId: string;
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

export interface ApiKeyOperationScope {
  apiKeyPolicy: EffectiveApiKeyPolicy;
  walletPolicy: EffectiveWalletPolicy | null;
  custodyWalletId: string | null;
}

interface ApiKeyPolicyAuthoringScope {
  organizationId: string;
  projectId: string;
  apiKeyId: string;
}

interface CreateApiKeyControlProfileInput extends ApiKeyPolicyAuthoringScope {
  name: string;
  createdBy?: string | null;
}

interface CreateApiKeyControlProfileRevisionInput extends ApiKeyPolicyAuthoringScope {
  profileId: string;
  rules: PolicyRule[];
  defaultAction: PolicyDefaultAction;
  createdBy?: string | null;
}

interface ActivateApiKeyControlProfileRevisionInput extends ApiKeyPolicyAuthoringScope {
  profileId: string;
  revisionId: string;
}

interface ReplaceApiKeyWalletPolicyBindingsInput extends ApiKeyPolicyAuthoringScope {
  bindings: UpsertApiKeyWalletPolicyBindingInput[];
}

/**
 * API-key-scope policy store: profile authoring, wallet bindings, and
 * effective-policy resolution for API keys.
 */
export class ApiKeyPolicyStore {
  private readonly walletPolicies: WalletPolicyStore;

  constructor(private readonly repository: PolicyRepository) {
    this.walletPolicies = new WalletPolicyStore(repository);
  }

  async createApiKeyControlProfile(
    input: CreateApiKeyControlProfileInput
  ): Promise<ApiKeyControlProfile> {
    await this.assertScopedApiKeyPolicySubject(input);
    const row = await this.repository.createApiKeyControlProfile({
      organizationId: input.organizationId,
      projectId: input.projectId,
      apiKeyId: input.apiKeyId,
      name: input.name,
      createdBy: input.createdBy,
    });

    if (!row) {
      throw internalError("Failed to create API key control profile");
    }
    return mapApiKeyControlProfile(row);
  }

  async createApiKeyControlProfileRevision(
    input: CreateApiKeyControlProfileRevisionInput
  ): Promise<ApiKeyControlProfileRevision> {
    const subject = await this.assertScopedApiKeyPolicySubject(input);
    await this.assertScopedApiKeyControlProfile(input.profileId, subject);
    const row = await this.repository.createApiKeyControlProfileRevision({
      profileId: input.profileId,
      rules: input.rules,
      defaultAction: input.defaultAction,
      createdBy: input.createdBy,
    });

    if (!row) {
      throw notFound("API key control profile");
    }
    return mapApiKeyControlProfileRevision(row);
  }

  async activateApiKeyControlProfileRevision(
    input: ActivateApiKeyControlProfileRevisionInput
  ): Promise<{ profile: ApiKeyControlProfile; revision: ApiKeyControlProfileRevision }> {
    const subject = await this.assertScopedApiKeyPolicySubject(input);
    await this.assertScopedApiKeyControlProfile(input.profileId, subject);
    const revision = await this.repository.getApiKeyControlProfileRevisionById(input.revisionId);
    if (!revision || revision.profile_id !== input.profileId) {
      throw notFound("API key control profile revision");
    }

    const active = await this.repository.activateApiKeyControlProfileRevision({
      profileId: input.profileId,
      revisionId: input.revisionId,
    });
    if (!active?.revision) {
      throw notFound("API key control profile revision");
    }

    return {
      profile: mapApiKeyControlProfile(active.profile),
      revision: mapApiKeyControlProfileRevision(active.revision),
    };
  }

  async replaceApiKeyWalletPolicyBindings(
    input: ReplaceApiKeyWalletPolicyBindingsInput
  ): Promise<ApiKeyWalletPolicyBinding[]> {
    await this.assertScopedApiKeyPolicySubject(input);
    this.assertUniquePolicyBindingTargets(input.bindings);

    const bindings: UpsertApiKeyWalletPolicyBindingInput[] = [];
    for (const binding of input.bindings) {
      if (binding.apiKeyId !== input.apiKeyId) {
        throw badRequest("Policy bindings must target the requested API key");
      }
      bindings.push(await this.validateApiKeyWalletPolicyBinding(binding));
    }

    const rows = await this.repository.replaceApiKeyWalletPolicyBindings({
      apiKeyId: input.apiKeyId,
      bindings,
    });
    return rows.map(mapApiKeyWalletPolicyBinding);
  }

  async resolveEffectiveApiKeyPolicy(apiKeyId: string): Promise<EffectiveApiKeyPolicy> {
    const active = await this.repository.getActiveApiKeyControlProfileByApiKeyId(apiKeyId);

    if (!active?.revision) {
      return IMPLICIT_DEFAULT_ALLOW_POLICY;
    }

    return {
      source: "customer_profile",
      profile: mapApiKeyControlProfile(active.profile),
      revision: mapApiKeyControlProfileRevision(active.revision),
      defaultAction: active.revision.default_action,
    };
  }

  /**
   * Resolve an API-key policy when an operation has no custody-wallet identity.
   *
   * @param apiKeyId - The API key initiating the operation.
   * @returns The effective API-key policy when no wallet bindings require a custody target.
   */
  async resolveOperationPolicyWithoutCustodyWallet(
    apiKeyId: string
  ): Promise<EffectiveApiKeyPolicy> {
    const bindings = await this.repository.listApiKeyWalletPolicyBindings(apiKeyId);
    if (bindings.length > 0) {
      throw forbidden("API key policy binding is not configured for the requested wallet");
    }
    return this.resolveEffectiveApiKeyPolicy(apiKeyId);
  }

  async upsertApiKeyWalletPolicyBinding(
    input: UpsertApiKeyWalletPolicyBindingInput
  ): Promise<ApiKeyWalletPolicyBinding> {
    const normalized = await this.validateApiKeyWalletPolicyBinding(input);
    const row = await this.repository.upsertApiKeyWalletPolicyBinding(normalized);
    if (!row) {
      throw internalError("Failed to upsert API key wallet policy binding");
    }
    return mapApiKeyWalletPolicyBinding(row);
  }

  async resolveApiKeyWalletPolicyScope(
    input: ResolveApiKeyWalletPolicyScopeInput
  ): Promise<ResolvedApiKeyWalletPolicyScope> {
    const resolution = await this.repository.getApiKeyWalletPolicyBindingResolution(
      input.apiKeyId,
      input.custodyWalletId
    );

    this.assertApplicablePolicyBindingExists(resolution);

    const target = await this.assertApiKeyWalletPolicyTarget(input);
    return await this.resolveApiKeyWalletPolicyScopeForTarget(input, target, resolution);
  }

  /**
   * Resolve the API-key scope for a policy-gated operation. Once the key has
   * wallet policy bindings, an inactive or out-of-scope requested wallet fails
   * closed instead of falling back to the plain per-key profile lookup; a
   * binding may also supply the wallet policy and custody wallet.
   *
   * @param input - The API key and requested custody wallet.
   * @returns The effective API-key policy plus any binding-supplied wallet scope.
   */
  async resolveOperationScope(
    input: ResolveApiKeyWalletPolicyScopeInput
  ): Promise<ApiKeyOperationScope> {
    const resolution = await this.repository.getApiKeyWalletPolicyBindingResolution(
      input.apiKeyId,
      input.custodyWalletId
    );

    if (resolution.total_binding_count === 0) {
      return {
        apiKeyPolicy: await this.resolveEffectiveApiKeyPolicy(input.apiKeyId),
        walletPolicy: null,
        custodyWalletId: null,
      };
    }

    this.assertApplicablePolicyBindingExists(resolution);
    const target = await this.assertApiKeyWalletPolicyTarget(input);
    const scope = await this.resolveApiKeyWalletPolicyScopeForTarget(input, target, resolution);
    return {
      apiKeyPolicy: scope.apiKeyPolicy,
      walletPolicy: scope.walletPolicy,
      custodyWalletId: scope.target.custodyWalletId,
    };
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
      ? await this.walletPolicies.resolveWalletPolicyProfileForBinding(
          binding.wallet_control_profile_id,
          target
        )
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
      input.custodyWalletId
    );

    if (!target) {
      throw forbidden("API key is not authorized for the requested wallet");
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

  private async validateApiKeyWalletPolicyBinding(
    input: UpsertApiKeyWalletPolicyBindingInput
  ): Promise<UpsertApiKeyWalletPolicyBindingInput> {
    if (!input.apiKeyControlProfileId && !input.walletControlProfileId) {
      throw badRequest("Policy bindings must reference at least one control profile");
    }

    if (input.bindingScope === "selected") {
      const target = await this.assertApiKeyWalletPolicyTarget({
        apiKeyId: input.apiKeyId,
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
        await this.walletPolicies.resolveWalletPolicyProfileForBinding(
          input.walletControlProfileId,
          target
        );
      }

      return {
        ...input,
        custodyWalletId: target.custody_wallet_id,
      };
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

    return input;
  }

  private async assertApiKeyPolicySubject(apiKeyId: string): Promise<ApiKeyPolicySubjectRow> {
    const subject = await this.repository.getApiKeyPolicySubject(apiKeyId);

    if (!subject) {
      throw forbidden("API key is not active for policy binding");
    }

    return subject;
  }

  private async assertScopedApiKeyPolicySubject(
    input: ApiKeyPolicyAuthoringScope
  ): Promise<ApiKeyPolicySubjectRow> {
    const subject = await this.repository.getApiKeyPolicySubject(input.apiKeyId);
    if (
      !subject ||
      subject.organization_id !== input.organizationId ||
      subject.project_id !== input.projectId
    ) {
      throw notFound("API key");
    }
    return subject;
  }

  private async assertScopedApiKeyControlProfile(
    profileId: string,
    subject: ApiKeyPolicySubjectRow
  ): Promise<ApiKeyControlProfileRow> {
    const profile = await this.repository.getApiKeyControlProfileById(profileId);
    if (
      !profile ||
      profile.api_key_id !== subject.api_key_id ||
      profile.organization_id !== subject.organization_id ||
      profile.project_id !== subject.project_id ||
      profile.status === "archived"
    ) {
      throw notFound("API key control profile");
    }
    return profile;
  }

  private assertUniquePolicyBindingTargets(bindings: UpsertApiKeyWalletPolicyBindingInput[]): void {
    const targets = new Set<string>();
    for (const binding of bindings) {
      const target = binding.bindingScope === "all" ? "all" : `selected:${binding.custodyWalletId}`;
      if (targets.has(target)) {
        throw badRequest("Policy binding targets must be unique");
      }
      targets.add(target);
    }
  }

  private assertPolicyBindingMatchesTarget(
    binding: ApiKeyWalletPolicyBindingRow,
    target: ApiKeyWalletPolicyTargetRow
  ): void {
    if (
      binding.binding_scope === "selected" &&
      binding.custody_wallet_id !== target.custody_wallet_id
    ) {
      throw forbidden("API key policy binding does not match the requested custody wallet");
    }
  }

  private async resolveApiKeyPolicyProfileForBinding(
    profileId: string,
    subject: ApiKeyPolicySubjectRow | ApiKeyWalletPolicyTargetRow,
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
