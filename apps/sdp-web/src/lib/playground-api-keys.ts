"use client";

const apiKeysById = new Map<string, string>();
const apiKeysByPrefix = new Map<string, string>();
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

export function storeApiKeySecret(params: {
  value: string;
  apiKeyId?: string | null;
  keyPrefix?: string | null;
}) {
  const normalized = normalizeApiKeyInput(params.value);
  if (!normalized) {
    return;
  }

  if (params.apiKeyId) {
    apiKeysById.set(params.apiKeyId, normalized);
  }
  if (params.keyPrefix) {
    apiKeysByPrefix.set(params.keyPrefix, normalized);
  }

  notifyApiKeySecretListeners();
}

export function getStoredApiKeySecret(params: {
  apiKeyId?: string | null;
  keyPrefix?: string | null;
}): string | null {
  if (params.apiKeyId) {
    const byId = apiKeysById.get(params.apiKeyId);
    if (byId) {
      return byId;
    }
  }

  if (params.keyPrefix) {
    const byPrefix = apiKeysByPrefix.get(params.keyPrefix);
    if (byPrefix) {
      return byPrefix;
    }
  }

  return null;
}

export function clearStoredApiKeySecret(params: {
  apiKeyId?: string | null;
  keyPrefix?: string | null;
}): void {
  let changed = false;

  if (params.apiKeyId) {
    changed = apiKeysById.delete(params.apiKeyId) || changed;
  }
  if (params.keyPrefix) {
    changed = apiKeysByPrefix.delete(params.keyPrefix) || changed;
  }

  if (changed) {
    notifyApiKeySecretListeners();
  }
}

export function subscribeToStoredApiKeySecrets(listener: () => void): () => void {
  apiKeySecretListeners.add(listener);
  return () => apiKeySecretListeners.delete(listener);
}

export function clearStoredApiKeySecrets(): void {
  const hadStoredSecrets = apiKeysById.size > 0 || apiKeysByPrefix.size > 0;
  apiKeysById.clear();
  apiKeysByPrefix.clear();
  if (hadStoredSecrets) {
    notifyApiKeySecretListeners();
  }
}
