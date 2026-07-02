import type { ApiKeyWalletPolicyBindingSummary } from "@sdp/types";
import {
  type ActivePolicyProfileRevisionRefRow,
  type ApiKeyWalletPolicyBindingRow,
  createPolicyRepository,
} from "@/db/repositories";
import {
  type ApiKeyWalletBinding,
  listApiKeyWalletBindingsForApiKeys,
} from "@/services/api-key-wallets.service";
import type { Env } from "@/types/env";

type ApiKeyWalletBindingsDb = Parameters<typeof listApiKeyWalletBindingsForApiKeys>[0];

export interface ApiKeyAccessSummary {
  keyId: string;
  walletBindings: ApiKeyWalletBinding[];
  policyBindings: ApiKeyWalletPolicyBindingSummary[];
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value))));
}

function revisionIdByProfileId(
  rows: ActivePolicyProfileRevisionRefRow[]
): Map<string, string | null> {
  return new Map(rows.map((row) => [row.profile_id, row.active_revision_id]));
}

function mapPolicyBindingSummary(
  binding: ApiKeyWalletPolicyBindingRow,
  walletRevisionIdByProfileId: Map<string, string | null>,
  apiKeyRevisionIdByProfileId: Map<string, string | null>
): ApiKeyWalletPolicyBindingSummary {
  return {
    id: binding.id,
    bindingScope: binding.binding_scope,
    walletId: binding.wallet_id,
    custodyWalletId: binding.custody_wallet_id,
    walletControlProfileId: binding.wallet_control_profile_id,
    walletControlProfileRevisionId: binding.wallet_control_profile_id
      ? (walletRevisionIdByProfileId.get(binding.wallet_control_profile_id) ?? null)
      : null,
    apiKeyControlProfileId: binding.api_key_control_profile_id,
    apiKeyControlProfileRevisionId: binding.api_key_control_profile_id
      ? (apiKeyRevisionIdByProfileId.get(binding.api_key_control_profile_id) ?? null)
      : null,
    createdAt: binding.created_at,
    updatedAt: binding.updated_at,
  };
}

export async function buildApiKeyAccessSummaries(
  env: Env,
  db: ApiKeyWalletBindingsDb,
  apiKeyIds: string[]
): Promise<Map<string, ApiKeyAccessSummary>> {
  const uniqueApiKeyIds = uniqueStrings(apiKeyIds);
  if (uniqueApiKeyIds.length === 0) {
    return new Map();
  }

  const policyRepository = createPolicyRepository(env);

  const [walletBindings, policyBindings] = await Promise.all([
    listApiKeyWalletBindingsForApiKeys(db, uniqueApiKeyIds),
    policyRepository.listApiKeyWalletPolicyBindingsForApiKeys(uniqueApiKeyIds),
  ]);

  const [walletRevisionRefs, apiKeyRevisionRefs] = await Promise.all([
    policyRepository.listActiveWalletControlProfileRevisionRefs(
      uniqueStrings(policyBindings.map((binding) => binding.wallet_control_profile_id))
    ),
    policyRepository.listActiveApiKeyControlProfileRevisionRefs(
      uniqueStrings(policyBindings.map((binding) => binding.api_key_control_profile_id))
    ),
  ]);

  const walletRevisionIdByProfileId = revisionIdByProfileId(walletRevisionRefs);
  const apiKeyRevisionIdByProfileId = revisionIdByProfileId(apiKeyRevisionRefs);
  const walletBindingsByKeyId = new Map<string, ApiKeyWalletBinding[]>();
  const policyBindingsByKeyId = new Map<string, ApiKeyWalletPolicyBindingSummary[]>();

  for (const binding of walletBindings) {
    const bindingsForKey = walletBindingsByKeyId.get(binding.apiKeyId) ?? [];
    bindingsForKey.push({
      walletId: binding.walletId,
      permissions: binding.permissions,
    });
    walletBindingsByKeyId.set(binding.apiKeyId, bindingsForKey);
  }

  for (const binding of policyBindings) {
    const bindingsForKey = policyBindingsByKeyId.get(binding.api_key_id) ?? [];
    bindingsForKey.push(
      mapPolicyBindingSummary(binding, walletRevisionIdByProfileId, apiKeyRevisionIdByProfileId)
    );
    policyBindingsByKeyId.set(binding.api_key_id, bindingsForKey);
  }

  return new Map(
    uniqueApiKeyIds.map((keyId) => [
      keyId,
      {
        keyId,
        walletBindings: walletBindingsByKeyId.get(keyId) ?? [],
        policyBindings: policyBindingsByKeyId.get(keyId) ?? [],
      },
    ])
  );
}
