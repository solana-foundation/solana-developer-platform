"use client";

import { useSyncExternalStore } from "react";
import { getStoredApiKeySecret, subscribeToStoredApiKeySecrets } from "./playground-api-keys";

interface StoredApiKeyIdentity {
  apiKeyId?: string | null;
  keyPrefix?: string | null;
}

export function usePlaygroundApiKeySecret({
  apiKeyId,
  keyPrefix,
}: StoredApiKeyIdentity): string | null {
  return useSyncExternalStore(
    subscribeToStoredApiKeySecrets,
    () => getStoredApiKeySecret({ apiKeyId, keyPrefix }),
    () => null
  );
}
