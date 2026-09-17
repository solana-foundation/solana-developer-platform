"use client";

const apiKeysById = new Map<string, string>();
const apiKeySecretListeners = new Set<() => void>();

function notifyApiKeySecretListeners(): void {
  for (const listener of apiKeySecretListeners) {
    listener();
  }
}

export function normalizeApiKeyInput(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith("Bearer ")) {
    return trimmed.slice(7).trim();
  }
  return trimmed;
}

export function storeApiKeySecret(params: { value: string; apiKeyId: string }) {
  const normalized = normalizeApiKeyInput(params.value);
  if (!normalized) {
    return;
  }

  apiKeysById.set(params.apiKeyId, normalized);

  notifyApiKeySecretListeners();
}

export function getStoredApiKeySecret(params: { apiKeyId?: string | null }): string | null {
  if (params.apiKeyId) {
    const byId = apiKeysById.get(params.apiKeyId);
    if (byId) {
      return byId;
    }
  }

  return null;
}

export function clearStoredApiKeySecret(params: { apiKeyId?: string | null }): void {
  const changed = params.apiKeyId ? apiKeysById.delete(params.apiKeyId) : false;

  if (changed) {
    notifyApiKeySecretListeners();
  }
}

export function subscribeToStoredApiKeySecrets(listener: () => void): () => void {
  apiKeySecretListeners.add(listener);
  return () => apiKeySecretListeners.delete(listener);
}

export function clearStoredApiKeySecrets(): void {
  const hadStoredSecrets = apiKeysById.size > 0;
  apiKeysById.clear();
  if (hadStoredSecrets) {
    notifyApiKeySecretListeners();
  }
}
