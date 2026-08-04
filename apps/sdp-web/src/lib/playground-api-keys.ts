"use client";

const apiKeysById = new Map<string, string>();
const apiKeysByPrefix = new Map<string, string>();

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

export function clearStoredApiKeySecrets(): void {
  apiKeysById.clear();
  apiKeysByPrefix.clear();
}
