/**
 * Authentication test helpers
 */

import { hashString } from "@/lib/hash";
import type { Env } from "@/types/env";
import { TEST_API_KEY, TEST_CACHED_API_KEY } from "../fixtures/api-keys";
import { seedCachedApiKey } from "../mocks/kv";

/**
 * Sets up authentication for a test request
 * Returns the Authorization header value
 */
export async function setupTestAuth(
  env: Env,
  options: { expired?: boolean; revoked?: boolean } = {}
): Promise<{ header: string; keyHash: string }> {
  const pepper = env.API_KEY_PEPPER;
  const keyHash = await hashString(TEST_API_KEY.raw, pepper);

  const cachedKey = { ...TEST_CACHED_API_KEY };

  if (options.expired) {
    cachedKey.expiresAt = "2020-01-01T00:00:00.000Z";
  }

  if (options.revoked) {
    cachedKey.status = "revoked";
  }

  await seedCachedApiKey(env, keyHash, cachedKey);

  return {
    header: `Bearer ${TEST_API_KEY.raw}`,
    keyHash,
  };
}

/**
 * Creates authenticated request headers
 */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: token,
    "Content-Type": "application/json",
  };
}
