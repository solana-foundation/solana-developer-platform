// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearStoredApiKeySecrets,
  getStoredApiKeySecret,
  normalizeApiKeyInput,
  storeApiKeySecret,
} from "./playground-api-keys";

describe("playground API key secrets", () => {
  beforeEach(() => {
    clearStoredApiKeySecrets();
  });

  it("keeps generated secrets only in memory", () => {
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const setItem = vi.spyOn(Storage.prototype, "setItem");

    storeApiKeySecret({
      value: "Bearer sk_sdp_generated",
      apiKeyId: "key-1",
      keyPrefix: "sk_sdp_",
    });

    expect(getStoredApiKeySecret({ apiKeyId: "key-1" })).toBe("sk_sdp_generated");
    expect(getStoredApiKeySecret({ keyPrefix: "sk_sdp_" })).toBe("sk_sdp_generated");
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
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
});
