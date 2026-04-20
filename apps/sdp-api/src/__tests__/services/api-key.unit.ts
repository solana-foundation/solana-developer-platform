/**
 * API Key Utils Unit Tests
 *
 * Tests for pure API key utility functions.
 * No mocks needed - these are pure functions.
 */

import { describe, expect, it } from "vitest";
import { createApiKeyMaterial, parseJsonArray, randomBase64Url } from "@/services/api-key.utils";

describe("parseJsonArray", () => {
  it("returns null for null input", () => {
    expect(parseJsonArray(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseJsonArray("")).toBeNull();
  });

  it("parses valid JSON array", () => {
    const result = parseJsonArray('["a", "b", "c"]');
    expect(result).toEqual(["a", "b", "c"]);
  });

  it("parses empty JSON array", () => {
    const result = parseJsonArray("[]");
    expect(result).toEqual([]);
  });

  it("returns null for invalid JSON", () => {
    expect(parseJsonArray("not json")).toBeNull();
  });

  it("parses non-array JSON (caller should validate)", () => {
    // Note: parseJsonArray doesn't validate array type
    // It's used in contexts where DB always stores arrays
    const result = parseJsonArray('{"key": "value"}');
    expect(result).toEqual({ key: "value" });
  });
});

describe("randomBase64Url", () => {
  it("generates string of correct length", () => {
    // 24 bytes -> 32 base64 characters (minus padding)
    const result = randomBase64Url(24);
    expect(result.length).toBeGreaterThanOrEqual(30);
    expect(result.length).toBeLessThanOrEqual(32);
  });

  it("uses base64url characters only", () => {
    const result = randomBase64Url(24);
    // Base64url: A-Z, a-z, 0-9, -, _ (no +, /, =)
    expect(result).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("generates unique values", () => {
    const results = new Set<string>();
    for (let i = 0; i < 100; i++) {
      results.add(randomBase64Url(24));
    }
    // All 100 should be unique (collision probability ~0)
    expect(results.size).toBe(100);
  });

  it("handles different byte lengths", () => {
    const short = randomBase64Url(8);
    const long = randomBase64Url(48);

    expect(short.length).toBeLessThan(long.length);
  });
});

describe("createApiKeyMaterial", () => {
  it("creates production key with live prefix", () => {
    const { key, prefix } = createApiKeyMaterial("production");

    expect(key).toMatch(/^sk_live_[A-Za-z0-9_-]+$/);
    expect(prefix).toMatch(/^sk_live_[A-Za-z0-9_-]{3}$/);
    expect(key.startsWith(prefix.replace(/_$/, ""))).toBe(true);
  });

  it("creates sandbox key with test prefix", () => {
    const { key, prefix } = createApiKeyMaterial("sandbox");

    expect(key).toMatch(/^sk_test_[A-Za-z0-9_-]+$/);
    expect(prefix).toMatch(/^sk_test_[A-Za-z0-9_-]{3}$/);
  });

  it("generates unique keys each time", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 100; i++) {
      const { key } = createApiKeyMaterial("sandbox");
      keys.add(key);
    }
    expect(keys.size).toBe(100);
  });

  it("prefix is first 11 chars of key for sandbox", () => {
    const { key, prefix } = createApiKeyMaterial("sandbox");
    // sk_test_ = 8 chars, then 3 more from random part
    expect(prefix.length).toBe(11);
    expect(key.substring(0, 11)).toBe(prefix);
  });

  it("prefix is first 11 chars of key for production", () => {
    const { key, prefix } = createApiKeyMaterial("production");
    // sk_live_ = 8 chars, then 3 more from random part
    expect(prefix.length).toBe(11);
    expect(key.substring(0, 11)).toBe(prefix);
  });
});
