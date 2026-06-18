/**
 * API Key Utilities
 *
 * Pure functions for API key generation and parsing.
 * Extracted from ApiKeyService for testability.
 */

import type { ApiKeyEnvironment } from "@sdp/types";

/**
 * Generate a cryptographically random base64url string.
 *
 * Uses Web Crypto API for randomness, compatible with both
 * Node.js (Buffer) and browser/worker (btoa) environments.
 */
export function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  const globalWithBuffer = globalThis as {
    Buffer?: {
      from: (input: Uint8Array) => { toString: (encoding: "base64") => string };
    };
  };

  if (globalWithBuffer.Buffer) {
    return globalWithBuffer.Buffer.from(bytes)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/g, "");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/**
 * Create API key material with environment-specific prefix.
 *
 * Format: sk_{envPrefix}_{randomPart}
 * - Production: sk_live_...
 * - Sandbox: sk_test_...
 */
export function createApiKeyMaterial(environment: ApiKeyEnvironment): {
  key: string;
  prefix: string;
} {
  const envPrefix = environment === "production" ? "live" : "test";
  const randomPart = randomBase64Url(24);
  const key = `sk_${envPrefix}_${randomPart}`;
  const prefix = `sk_${envPrefix}_${randomPart.slice(0, 3)}`;
  return { key, prefix };
}
