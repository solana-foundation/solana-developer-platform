/**
 * Cryptographic utilities for API key generation and hashing
 */

import { customAlphabet } from "nanoid";

// Base62 alphabet for URL-safe IDs
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// ID generators with prefixes
const generateId = customAlphabet(BASE62, 16);

export function generateOrgId(): string {
  return `org_${generateId()}`;
}

export function generateUserId(): string {
  return `usr_${generateId()}`;
}

export function generateApiKeyId(): string {
  return `key_${generateId()}`;
}

export function generateMemberId(): string {
  return `mem_${generateId()}`;
}

export function generateInvitationId(): string {
  return `inv_${generateId()}`;
}

export function generateAuditLogId(): string {
  return `aud_${generateId()}`;
}

export function generateAllowlistId(): string {
  return `al_${generateId()}`;
}

/**
 * Generate a cryptographically secure API key
 *
 * Format: sk_{env}_{32 random base62 chars}
 * Example: sk_live_abc123def456ghi789jkl012mno345pq
 */
export function generateApiKey(environment: "sandbox" | "production"): {
  key: string;
  prefix: string;
} {
  const envPrefix = environment === "production" ? "live" : "test";
  const randomPart = customAlphabet(BASE62, 32)();
  const key = `sk_${envPrefix}_${randomPart}`;
  const prefix = `sk_${envPrefix}_${randomPart.slice(0, 3)}`;

  return { key, prefix };
}

/**
 * Generate an invitation token
 */
export function generateInvitationToken(): string {
  return customAlphabet(BASE62, 48)();
}

/**
 * Hash a string using SHA-256
 * Used for API keys and invitation tokens
 */
export async function hashString(input: string, pepper?: string): Promise<string> {
  const data = pepper ? `${input}:${pepper}` : input;
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest("SHA-256", dataBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function secureCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Generate a random request ID for tracing
 */
export function generateRequestId(): string {
  return `req_${customAlphabet(BASE62, 12)()}`;
}
