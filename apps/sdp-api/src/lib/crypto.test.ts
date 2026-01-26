/**
 * Crypto utilities tests
 */

import { describe, expect, it } from "vitest";
import {
  generateApiKey,
  generateApiKeyId,
  generateOrgId,
  generateRequestId,
  generateUserId,
  hashString,
  secureCompare,
} from "./crypto";

describe("crypto utilities", () => {
  describe("ID generation", () => {
    it("generates org IDs with correct prefix", () => {
      const id = generateOrgId();
      expect(id).toMatch(/^org_[A-Za-z0-9]{16}$/);
    });

    it("generates user IDs with correct prefix", () => {
      const id = generateUserId();
      expect(id).toMatch(/^usr_[A-Za-z0-9]{16}$/);
    });

    it("generates API key IDs with correct prefix", () => {
      const id = generateApiKeyId();
      expect(id).toMatch(/^key_[A-Za-z0-9]{16}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateOrgId()));
      expect(ids.size).toBe(100);
    });

    it("generates request IDs with correct prefix", () => {
      const id = generateRequestId();
      expect(id).toMatch(/^req_[A-Za-z0-9]{12}$/);
    });
  });

  describe("API key generation", () => {
    it("generates sandbox keys with test prefix", () => {
      const { key, prefix } = generateApiKey("sandbox");
      expect(key).toMatch(/^sk_test_[A-Za-z0-9]{32}$/);
      expect(prefix).toMatch(/^sk_test_[A-Za-z0-9]{3}$/);
      expect(key.startsWith(prefix)).toBe(true);
    });

    it("generates production keys with live prefix", () => {
      const { key, prefix } = generateApiKey("production");
      expect(key).toMatch(/^sk_live_[A-Za-z0-9]{32}$/);
      expect(prefix).toMatch(/^sk_live_[A-Za-z0-9]{3}$/);
    });
  });

  describe("hashString", () => {
    it("produces consistent hashes", async () => {
      const hash1 = await hashString("test-input");
      const hash2 = await hashString("test-input");
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes with pepper", async () => {
      const hash1 = await hashString("test-input");
      const hash2 = await hashString("test-input", "pepper");
      expect(hash1).not.toBe(hash2);
    });

    it("produces 64-character hex strings", async () => {
      const hash = await hashString("test");
      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("secureCompare", () => {
    it("returns true for equal strings", () => {
      expect(secureCompare("abc123", "abc123")).toBe(true);
    });

    it("returns false for different strings", () => {
      expect(secureCompare("abc123", "abc124")).toBe(false);
    });

    it("returns false for different lengths", () => {
      expect(secureCompare("abc", "abcd")).toBe(false);
    });

    it("returns true for empty strings", () => {
      expect(secureCompare("", "")).toBe(true);
    });
  });
});
