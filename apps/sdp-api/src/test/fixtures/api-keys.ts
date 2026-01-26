/**
 * API Key test fixtures
 */

import type { CachedApiKey } from "@sdp/types";
import { TEST_ORG } from "./organizations";

export const TEST_API_KEY = {
  id: "key_test123456789",
  raw: "sk_test_testkey123456789012345678901234",
  prefix: "sk_test_tes",
};

export const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  status: "active",
  expiresAt: null,
};

export const TEST_REVOKED_KEY: CachedApiKey = {
  ...TEST_CACHED_API_KEY,
  id: "key_revoked123456",
  status: "revoked",
};

export const TEST_EXPIRED_KEY: CachedApiKey = {
  ...TEST_CACHED_API_KEY,
  id: "key_expired123456",
  expiresAt: "2020-01-01T00:00:00.000Z",
};
