/**
 * API Key Utilities
 *
 * Pure functions for API key generation and parsing.
 * Extracted from ApiKeyService for testability.
 */

import { generateSfApiKey, SF_API_KEY_PREFIX } from "@/lib/api-key-format";

/**
 * Create the material for a new API key, in the shared `sf_` format
 * (HOO-2256; see `@/lib/api-key-format`). The environment is no longer part
 * of the key: it comes from the key's project.
 *
 * - key: the full `sf_<key id>_<secret><checksum>`, shown once
 * - publicId: the key ID, stored in `api_keys.public_id`
 * - secret: the part `hashApiKey` hashes
 * - prefix: `sf_<key id>`, for display
 */
export function createApiKeyMaterial(): {
  key: string;
  publicId: string;
  secret: string;
  prefix: string;
} {
  const { key, keyId, secret } = generateSfApiKey();
  return { key, publicId: keyId, secret, prefix: `${SF_API_KEY_PREFIX}${keyId}` };
}
