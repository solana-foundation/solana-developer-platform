/**
 * API Key test fixtures
 */

import { type Action, API_KEY_GRANTABLE_ACTIONS } from "@sdp/types/actions";
import type { SeededApiKey } from "@/test/mocks/db";
import { TEST_ORG } from "./organizations";
import { TEST_PROJECT } from "./tokens";

export const TEST_API_KEY = {
  id: "key_test123456789",
  raw: "sk_test_shared_fixture",
  prefix: "sk_test_sha",
};

export const TEST_PRODUCTION_API_KEY = {
  id: "key_test_production",
  raw: "sk_live_shared_fixture",
  prefix: "sk_live_sha",
};

/** Every action an API key may hold: what the dashboard's "Everything" writes. */
export const ALL_API_KEY_GRANTS: Action[] = [...API_KEY_GRANTABLE_ACTIONS];

/** {@link ALL_API_KEY_GRANTS} as a Postgres `text[]` literal, for SQL written inline. */
export const ALL_API_KEY_GRANTS_SQL = `'{${ALL_API_KEY_GRANTS.join(",")}}'`;

export const TEST_SEEDED_API_KEY: SeededApiKey = {
  id: TEST_API_KEY.id,
  organizationId: TEST_ORG.id,
  projectId: TEST_PROJECT.id,
  grants: ALL_API_KEY_GRANTS,
  environment: "sandbox",
  rateLimitTier: "standard",
  allowedIps: null,
  signingWalletId: null,
  status: "active",
  expiresAt: null,
  rotationDeadline: null,
  organizationStatus: "active",
};

export const TEST_REVOKED_KEY: SeededApiKey = {
  ...TEST_SEEDED_API_KEY,
  id: "key_revoked123456",
  status: "revoked",
};

export const TEST_EXPIRED_KEY: SeededApiKey = {
  ...TEST_SEEDED_API_KEY,
  id: "key_expired123456",
  expiresAt: "2020-01-01T00:00:00.000Z",
};
