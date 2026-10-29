import { hashString } from "@sdp/payments/hash";

/**
 * The stored hash of an API key: HMAC-SHA-256 under `API_KEY_PEPPER` (HOO-2219).
 * There is no unpeppered fallback: without the pepper a key would be stored, or
 * looked up, as plain SHA-256, which a leaked table gives up to offline guessing
 * and which no key minted under the pepper ever matches. The API refuses to boot
 * without it (`assertRequiredEnv`); this refuses the hash in case it is reached
 * some other way.
 */
export async function hashApiKey(key: string, pepper: string | undefined): Promise<string> {
  if (!pepper?.trim()) {
    throw new Error("API_KEY_PEPPER is required to hash API keys");
  }
  return hashString(key, pepper);
}
