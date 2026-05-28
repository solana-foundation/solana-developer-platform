/**
 * API Key test fixtures
 */

import type { CachedApiKey } from "@sdp/types";
import { TEST_ORG } from "./organizations";
import { TEST_PROJECT } from "./tokens";

export const TEST_API_KEY = {
  id: "key_test123456789",
  raw: "sk_test_shared_fixture",
  prefix: "sk_test_sha",
};

export const TEST_CACHED_API_KEY: CachedApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  role: "api_admin",
  permissions: ["*"],
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
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
