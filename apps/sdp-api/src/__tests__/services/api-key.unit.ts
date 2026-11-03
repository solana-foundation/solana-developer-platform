/**
 * API Key Utils Unit Tests
 *
 * Tests for pure API key utility functions.
 * No mocks needed - these are pure functions.
 */

import { describe, expect, it } from "vitest";
import { parseSfApiKey } from "@/lib/api-key-format";
import { createApiKeyMaterial } from "@/services/api-key.utils";

describe("createApiKeyMaterial", () => {
  it("creates an sf_ key whose prefix is its key ID", () => {
    const { key, publicId, secret, prefix } = createApiKeyMaterial();

    expect(key).toMatch(/^sf_[0-9a-f]{16}_[0-9A-Za-z]{49}$/);
    expect(prefix).toBe(`sf_${publicId}`);
    expect(key.startsWith(`${prefix}_${secret}`)).toBe(true);
    expect(parseSfApiKey(key)).toEqual({ keyId: publicId, secret });
  });

  it("generates unique keys and key IDs each time", () => {
    const keys = new Set<string>();
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { key, publicId } = createApiKeyMaterial();
      keys.add(key);
      ids.add(publicId);
    }
    expect(keys.size).toBe(100);
    expect(ids.size).toBe(100);
  });
});
