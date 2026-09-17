"use client";

export const PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1000;

interface StoredApiKeySecret {
  value: string;
  lastActivityAt: number;
}

const apiKeysById = new Map<string, StoredApiKeySecret>();
const apiKeySecretListeners = new Set<() => void>();
let activeWorkspaceScope: string | null | undefined;
let expiryTimer: ReturnType<typeof setTimeout> | null = null;

function notifyApiKeySecretListeners(): void {
  for (const listener of apiKeySecretListeners) {
    listener();
  }
}

function cancelExpiryTimer(): void {
  if (expiryTimer !== null) {
    clearTimeout(expiryTimer);
    expiryTimer = null;
  }
}

function clearExpiredApiKeySecrets(now: number): boolean {
  let changed = false;
  for (const [apiKeyId, secret] of apiKeysById) {
    if (now - secret.lastActivityAt >= PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS) {
      apiKeysById.delete(apiKeyId);
      changed = true;
    }
  }
  return changed;
}

function scheduleExpiryCheck(now = Date.now()): void {
  cancelExpiryTimer();
  if (apiKeysById.size === 0) {
    return;
  }

  const nextExpiryAt = Math.min(
    ...Array.from(
      apiKeysById.values(),
      (secret) => secret.lastActivityAt + PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS
    )
  );
  expiryTimer = setTimeout(
    () => {
      expiryTimer = null;
      const changed = clearExpiredApiKeySecrets(Date.now());
      scheduleExpiryCheck();
      if (changed) {
        notifyApiKeySecretListeners();
      }
    },
    Math.max(0, nextExpiryAt - now)
  );
}

/**
 * Shape check only. It says the string could be SDP key material, never that the
 * key exists or belongs to this project. Only the API can answer that, by
 * hashing the whole key.
 */
export function isValidSdpApiKey(rawValue: string): boolean {
  return /^sk_(test|live)_[A-Za-z0-9_-]+$/.test(rawValue);
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

  const now = Date.now();
  apiKeysById.set(params.apiKeyId, { value: normalized, lastActivityAt: now });
  scheduleExpiryCheck(now);

  notifyApiKeySecretListeners();
}

export function getStoredApiKeySecret(params: { apiKeyId?: string | null }): string | null {
  if (params.apiKeyId) {
    const secret = apiKeysById.get(params.apiKeyId);
    if (secret) {
      const now = Date.now();
      if (now - secret.lastActivityAt >= PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS) {
        apiKeysById.delete(params.apiKeyId);
        scheduleExpiryCheck(now);
        notifyApiKeySecretListeners();
        return null;
      }

      secret.lastActivityAt = now;
      scheduleExpiryCheck(now);
      return secret.value;
    }
  }

  return null;
}

export function peekStoredApiKeySecret(params: { apiKeyId?: string | null }): string | null {
  if (!params.apiKeyId) {
    return null;
  }

  const secret = apiKeysById.get(params.apiKeyId);
  if (!secret || Date.now() - secret.lastActivityAt >= PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS) {
    return null;
  }
  return secret.value;
}

export function clearStoredApiKeySecret(params: { apiKeyId?: string | null }): void {
  const changed = params.apiKeyId ? apiKeysById.delete(params.apiKeyId) : false;

  if (changed) {
    scheduleExpiryCheck();
    notifyApiKeySecretListeners();
  }
}

export function syncStoredApiKeySecretScope(scope: string | null): void {
  if (activeWorkspaceScope === undefined) {
    activeWorkspaceScope = scope;
    return;
  }
  if (activeWorkspaceScope === scope) {
    return;
  }

  activeWorkspaceScope = scope;
  clearStoredApiKeySecrets();
}

export function subscribeToStoredApiKeySecrets(listener: () => void): () => void {
  apiKeySecretListeners.add(listener);
  return () => apiKeySecretListeners.delete(listener);
}

export function clearStoredApiKeySecrets(): void {
  const hadStoredSecrets = apiKeysById.size > 0;
  apiKeysById.clear();
  cancelExpiryTimer();
  if (hadStoredSecrets) {
    notifyApiKeySecretListeners();
  }
}
