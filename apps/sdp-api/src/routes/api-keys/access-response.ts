import {
  type ApiKeyWalletBinding,
  listApiKeyWalletBindingsForApiKeys,
} from "@/services/api-key-wallets.service";

type ApiKeyWalletBindingsDb = Parameters<typeof listApiKeyWalletBindingsForApiKeys>[0];

export interface ApiKeyAccessSummary {
  keyId: string;
  walletBindings: ApiKeyWalletBinding[];
}

export async function buildApiKeyAccessSummaries(
  db: ApiKeyWalletBindingsDb,
  apiKeyIds: string[]
): Promise<Map<string, ApiKeyAccessSummary>> {
  const uniqueApiKeyIds = Array.from(new Set(apiKeyIds.filter(Boolean)));
  if (uniqueApiKeyIds.length === 0) {
    return new Map();
  }

  const walletBindings = await listApiKeyWalletBindingsForApiKeys(db, uniqueApiKeyIds);
  const walletBindingsByKeyId = new Map<string, ApiKeyWalletBinding[]>();

  for (const binding of walletBindings) {
    const bindingsForKey = walletBindingsByKeyId.get(binding.apiKeyId) ?? [];
    bindingsForKey.push({
      walletId: binding.walletId,
      permissions: binding.permissions,
    });
    walletBindingsByKeyId.set(binding.apiKeyId, bindingsForKey);
  }

  return new Map(
    uniqueApiKeyIds.map((keyId) => [
      keyId,
      { keyId, walletBindings: walletBindingsByKeyId.get(keyId) ?? [] },
    ])
  );
}
