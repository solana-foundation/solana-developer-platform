export function syncPlaygroundApiKeysForActiveTab<T>(
  isPlaygroundTab: boolean,
  apiKeys: T[],
  setPlaygroundApiKeys: (keys: T[]) => void
): void {
  if (isPlaygroundTab) {
    setPlaygroundApiKeys(apiKeys);
  }
}
