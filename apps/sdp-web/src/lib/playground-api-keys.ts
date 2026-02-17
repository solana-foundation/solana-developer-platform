"use client";

const STORAGE_KEY = "sdp.playground.api-keys.v1";

interface StoredApiKeys {
  byId: Record<string, string>;
  byPrefix: Record<string, string>;
}

function getEmptyStore(): StoredApiKeys {
  return { byId: {}, byPrefix: {} };
}

function readStore(): StoredApiKeys {
  if (typeof window === "undefined") {
    return getEmptyStore();
  }

  const raw = window.sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return getEmptyStore();
  }

  try {
    const parsed = JSON.parse(raw) as StoredApiKeys;
    return {
      byId: parsed.byId ?? {},
      byPrefix: parsed.byPrefix ?? {},
    };
  } catch {
    return getEmptyStore();
  }
}

function writeStore(store: StoredApiKeys) {
  if (typeof window === "undefined") {
    return;
  }

  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(store));
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

  const store = readStore();
  if (params.apiKeyId) {
    store.byId[params.apiKeyId] = normalized;
  }
  if (params.keyPrefix) {
    store.byPrefix[params.keyPrefix] = normalized;
  }

  writeStore(store);
}

export function getStoredApiKeySecret(params: {
  apiKeyId?: string | null;
  keyPrefix?: string | null;
}): string | null {
  const store = readStore();

  if (params.apiKeyId) {
    const byId = store.byId[params.apiKeyId];
    if (byId) {
      return byId;
    }
  }

  if (params.keyPrefix) {
    const byPrefix = store.byPrefix[params.keyPrefix];
    if (byPrefix) {
      return byPrefix;
    }
  }

  return null;
}
