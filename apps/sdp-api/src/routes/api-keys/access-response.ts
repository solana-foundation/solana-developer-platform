import type { ApiKeyWalletPolicyBinding, ApiKeyWalletPolicyBindingSummary } from "@sdp/types";
import { createPolicyRepository, type PolicyRepository } from "@/db/repositories";
import {
  type ApiKeyWalletBinding,
  listApiKeyWalletBindings,
} from "@/services/api-key-wallets.service";
import { PolicyFoundationService } from "@/services/policy-foundation.service";
import type { Env } from "@/types/env";

type ApiKeyWalletBindingsDb = Parameters<typeof listApiKeyWalletBindings>[0];

export interface ApiKeyAccessSummary {
  keyId: string;
  walletBindings: ApiKeyWalletBinding[];
  policyBindings: ApiKeyWalletPolicyBindingSummary[];
}

async function mapPolicyBindingSummary(
  binding: ApiKeyWalletPolicyBinding,
  policyRepository: PolicyRepository
): Promise<ApiKeyWalletPolicyBindingSummary> {
  const [walletProfile, apiKeyProfile] = await Promise.all([
    binding.walletControlProfileId
      ? policyRepository.getActiveWalletControlProfileByProfileId(binding.walletControlProfileId)
      : Promise.resolve(null),
    binding.apiKeyControlProfileId
      ? policyRepository.getActiveApiKeyControlProfileByProfileId(binding.apiKeyControlProfileId)
      : Promise.resolve(null),
  ]);

  return {
    id: binding.id,
    bindingScope: binding.bindingScope,
    walletId: binding.walletId,
    custodyWalletId: binding.custodyWalletId,
    walletControlProfileId: binding.walletControlProfileId,
    walletControlProfileRevisionId: walletProfile?.revision?.id ?? null,
    apiKeyControlProfileId: binding.apiKeyControlProfileId,
    apiKeyControlProfileRevisionId: apiKeyProfile?.revision?.id ?? null,
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
  };
}

async function mapPolicyBindingSummaries(
  bindings: ApiKeyWalletPolicyBinding[],
  policyRepository: PolicyRepository
): Promise<ApiKeyWalletPolicyBindingSummary[]> {
  return await Promise.all(
    bindings.map((binding) => mapPolicyBindingSummary(binding, policyRepository))
  );
}

export async function buildApiKeyAccessSummaries(
  env: Env,
  db: ApiKeyWalletBindingsDb,
  apiKeyIds: string[]
): Promise<Map<string, ApiKeyAccessSummary>> {
  const policyRepository = createPolicyRepository(env);
  const policyService = new PolicyFoundationService(policyRepository);
  const summaries = await Promise.all(
    apiKeyIds.map(async (keyId) => {
      const [walletBindings, policyBindings] = await Promise.all([
        listApiKeyWalletBindings(db, keyId),
        policyService
          .listApiKeyWalletPolicyBindings(keyId)
          .then((bindings) => mapPolicyBindingSummaries(bindings, policyRepository)),
      ]);

      return {
        keyId,
        walletBindings,
        policyBindings,
      };
    })
  );

  return new Map(summaries.map((summary) => [summary.keyId, summary]));
}
