// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredApiKeySecret,
  clearStoredApiKeySecrets,
  getStoredApiKeySecret,
  normalizeApiKeyInput,
  PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS,
  storeApiKeySecret,
  subscribeToStoredApiKeySecrets,
  syncStoredApiKeySecretScope,
} from "./playground-api-keys";

describe("playground API key secrets", () => {
  beforeEach(() => {
    clearStoredApiKeySecrets();
  });

  afterEach(() => {
    clearStoredApiKeySecrets();
    vi.useRealTimers();
  });

  it("keeps generated secrets only in memory", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    storeApiKeySecret({
      value: "Bearer sk_sdp_generated",
      apiKeyId: "key-1",
    });

    expect(getStoredApiKeySecret({ apiKeyId: "key-1" })).toBe("sk_sdp_generated");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
  });

  it("does not expose a secret to a different API key ID", () => {
    storeApiKeySecret({ value: "sk_sdp_workspace_a", apiKeyId: "key-workspace-a" });

    expect(getStoredApiKeySecret({ apiKeyId: "key-workspace-b" })).toBeNull();
  });

  it("does not retain empty values and can clear all secrets", () => {
    storeApiKeySecret({ value: "   ", apiKeyId: "empty" });
    expect(getStoredApiKeySecret({ apiKeyId: "empty" })).toBeNull();

    storeApiKeySecret({ value: "secret", apiKeyId: "key-2" });
    clearStoredApiKeySecrets();
    expect(getStoredApiKeySecret({ apiKeyId: "key-2" })).toBeNull();
  });

  it("normalizes pasted bearer credentials", () => {
    expect(normalizeApiKeyInput("  Bearer sk_sdp_example  ")).toBe("sk_sdp_example");
  });

  it("expires a secret after 15 minutes without activity", () => {
    vi.useFakeTimers();
    const storedAt = new Date("2026-09-17T00:00:00.000Z");
    vi.setSystemTime(storedAt);
    storeApiKeySecret({ value: "sk_test_expiring", apiKeyId: "key-expiring" });

    vi.setSystemTime(storedAt.getTime() + PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS);

    expect(getStoredApiKeySecret({ apiKeyId: "key-expiring" })).toBeNull();
  });

  it("extends expiry only when the secret is accessed through the store", () => {
    vi.useFakeTimers();
    const storedAt = new Date("2026-09-17T00:00:00.000Z");
    vi.setSystemTime(storedAt);
    storeApiKeySecret({ value: "sk_test_active", apiKeyId: "key-active" });

    vi.setSystemTime(storedAt.getTime() + PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS - 1);
    expect(getStoredApiKeySecret({ apiKeyId: "key-active" })).toBe("sk_test_active");

    vi.setSystemTime(storedAt.getTime() + 2 * PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS - 2);
    expect(getStoredApiKeySecret({ apiKeyId: "key-active" })).toBe("sk_test_active");

    vi.setSystemTime(storedAt.getTime() + 3 * PLAYGROUND_API_KEY_INACTIVITY_TIMEOUT_MS - 2);
    expect(getStoredApiKeySecret({ apiKeyId: "key-active" })).toBeNull();
  });

  it("clears secrets once when the authenticated workspace scope changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToStoredApiKeySecrets(listener);
    syncStoredApiKeySecretScope("user-a:org-a:project-a");
    storeApiKeySecret({ value: "sk_test_scoped", apiKeyId: "key-scoped" });
    listener.mockClear();

    syncStoredApiKeySecretScope("user-a:org-b:project-b");
    syncStoredApiKeySecretScope("user-a:org-b:project-b");

    expect(getStoredApiKeySecret({ apiKeyId: "key-scoped" })).toBeNull();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("notifies subscribers when a selected secret changes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToStoredApiKeySecrets(listener);

    storeApiKeySecret({ value: "sk_test_example", apiKeyId: "key-3" });
    clearStoredApiKeySecret({ apiKeyId: "key-3" });

    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    storeApiKeySecret({ value: "sk_test_other", apiKeyId: "key-4" });
    expect(listener).toHaveBeenCalledTimes(2);
  });
});
