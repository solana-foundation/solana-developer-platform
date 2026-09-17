"use client";

import { useSyncExternalStore } from "react";
import { getStoredApiKeySecret, subscribeToStoredApiKeySecrets } from "./playground-api-keys";

interface StoredApiKeyIdentity {
  apiKeyId?: string | null;
}

export function usePlaygroundApiKeySecret({ apiKeyId }: StoredApiKeyIdentity): string | null {
  return useSyncExternalStore(
    subscribeToStoredApiKeySecrets,
    () => getStoredApiKeySecret({ apiKeyId }),
    () => null
  );
}
